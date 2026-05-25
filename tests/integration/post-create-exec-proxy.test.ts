// Integration test for openlock-hnp: proves the POST-CREATE harness exec
// path (the one openlock uses when attaching to an existing sandbox) routes
// outbound traffic through the proxy. The original bug: openlock used raw
// `podman exec` to launch the harness, which bypasses the openshell-sandbox
// supervisor entirely — no HTTPS_PROXY env, no Landlock, no cred_inject.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 because the test:
//   - requires a working podman environment (Mac or Linux),
//   - builds/uses the core sandbox image (~minutes on first run),
//   - starts the openshell gateway,
//   - creates and tears down a real container.
//
// The regression vector (builder argv shape) is statically covered by unit
// tests in src/sandbox/container.test.ts. This test closes the end-to-end
// loop: a process spawned post-create via the new path actually goes via
// the proxy with cred_inject + header strip applied.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOpenshellExecArgv } from "../../src/sandbox/container";
import {
  containerfileKeyForCaps,
  DEFAULT_CONTAINERFILES,
} from "../../src/sandbox/default-containerfiles";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { ensureImage } from "../../src/sandbox/image-build";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const PROVIDER_NAME = "openlock-test-hnp";
const SECRET_VALUE = "post-create-secret-12345";
const FIXTURE_POLICY = resolve(__dirname, "../fixtures/policies/test-harness-mechanism.yaml");

async function spawnAndCapture(
  argv: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function gitInit(dir: string): Promise<void> {
  const init = await spawnAndCapture(["git", "init", "-q", "-b", "main"], dir);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
  writeFileSync(join(dir, "README"), "test repo\n");
  const cfg = await spawnAndCapture(
    [
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    dir,
  );
  if (cfg.code !== 0) throw new Error(`git commit failed: ${cfg.stderr}`);
}

async function waitForSandboxReady(
  cliPrefix: readonly string[],
  cliCwd: string | undefined,
  sessionName: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Probe via a no-op exec; the gateway rejects with "not ready" until the
    // supervisor finishes provisioning. /bin/true is a cheap success marker.
    const r = await spawnAndCapture(
      [...cliPrefix, "sandbox", "exec", "--name", sessionName, "--no-tty", "--", "/bin/true"],
      cliCwd,
    );
    if (r.code === 0) return;
    await Bun.sleep(500);
  }
  throw new Error(`sandbox ${sessionName} did not reach Ready state within ${timeoutMs}ms`);
}

describe("post-create harness exec routes via proxy (openlock-hnp)", () => {
  it.skipIf(!LIVE)(
    "buildOpenshellExecArgv path enforces proxy + cred_inject post-create",
    async () => {
      const sessionName = `openlock-test-hnp-${Date.now().toString(36)}`;
      const containerName = `openshell-sandbox-${sessionName}`;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-hnp-"));
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir);
      await gitInit(repoDir);

      const staging = join(tmp, "staging", ".openlock");
      mkdirSync(staging, { recursive: true });
      await createBundle(repoDir, join(staging, "repo.bundle"));

      const cli = await getCliInvocation();
      const argvHead = cli.argv;
      const removeProvider = async (): Promise<void> => {
        await spawnAndCapture([...argvHead, "provider", "delete", PROVIDER_NAME], cli.cwd);
      };
      const removeContainer = async (): Promise<void> => {
        await spawnAndCapture([
          process.env.OPENLOCK_RUNTIME ?? "podman",
          "rm",
          "-f",
          containerName,
        ]);
      };

      try {
        await startGateway();

        await removeProvider();
        const created = await spawnAndCapture(
          [
            ...argvHead,
            "provider",
            "create",
            "--name",
            PROVIDER_NAME,
            "--type",
            "generic",
            "--credential",
            `TEST_ECHO_VAL=${SECRET_VALUE}`,
          ],
          cli.cwd,
        );
        if (created.code !== 0) {
          throw new Error(`provider create failed: ${created.stderr}`);
        }

        const imageKey = containerfileKeyForCaps([]);
        const image = await ensureImage({
          containerfileContent: DEFAULT_CONTAINERFILES[imageKey],
          tagPrefix: `openlock-${imageKey}`,
        });

        // Create a long-running sandbox: the supervisor (PID 1 in container)
        // sleeps; the foreground command we exec post-create is the actual
        // network-emitting process. This mirrors the openlock attach path.
        const createArgv = [
          ...argvHead,
          "sandbox",
          "create",
          "--name",
          sessionName,
          "--from",
          image.tag,
          "--upload",
          `${join(tmp, "staging")}:/sandbox/`,
          "--no-git-ignore",
          "--policy",
          FIXTURE_POLICY,
          "--provider",
          PROVIDER_NAME,
          "--no-tty",
          "--",
          "/bin/sh",
          "-c",
          "exec sleep infinity",
        ];

        const createProc = Bun.spawn(createArgv, {
          cwd: cli.cwd,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        // Don't await createProc.exited — it only returns when the container
        // foreground exits (i.e. never, since we sleep).
        await waitForSandboxReady(argvHead, cli.cwd, sessionName);

        // The fix under test: post-create exec via openshell sandbox exec.
        // If openlock-hnp regressed (raw podman exec), curl would talk to
        // mock.opencode.test directly, fail DNS or be denied, and no echo
        // JSON would come back.
        const curlArgv = [
          "curl",
          "-sf",
          "-H",
          "X-Original-Header: original-value",
          "https://mock.opencode.test:8443/",
        ];
        const execArgv = buildOpenshellExecArgv(argvHead, sessionName, curlArgv, {
          workdir: "/sandbox/repo",
          tty: "off",
        });
        // Sanity guard: builder must never emit raw `podman exec`.
        expect(execArgv.join(" ")).not.toMatch(/\bpodman\s+exec\b/);

        const result = await spawnAndCapture(execArgv, cli.cwd);
        const jsonStart = result.stdout.indexOf("{");
        if (jsonStart === -1) {
          createProc.kill();
          throw new Error(
            `no JSON in stdout (code=${result.code}); stdout=${result.stdout}; stderr=${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.slice(jsonStart));

        expect(parsed.echo).toBe(true);
        expect(parsed.cred_inject_applied).toBe(true);
        const headers = parsed.headers as Record<string, string>;
        const headerKeys = Object.keys(headers);
        const xTestEcho = headerKeys.find((k) => k.toLowerCase() === "x-test-echo");
        expect(xTestEcho).toBeTruthy();
        expect(xTestEcho && headers[xTestEcho]).toBe(SECRET_VALUE);
        const xOriginal = headerKeys.find((k) => k.toLowerCase() === "x-original-header");
        expect(xOriginal).toBeUndefined();

        createProc.kill();
        // Reap to free the supervisor SSH session + gateway slot before the
        // next test runs (sibling integration tests share the same gateway).
        await createProc.exited;
      } finally {
        await removeContainer();
        await removeProvider();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
