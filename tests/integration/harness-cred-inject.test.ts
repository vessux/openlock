// Integration test: validates that cred_inject applies to the opencode
// harness binary entry by routing a request from inside the sandbox
// through the proxy's `echo: true` endpoint mode. The proxy intercepts
// the CONNECT, runs the full strip-and-replace pipeline, and returns the
// post-rewrite headers as JSON instead of forwarding upstream — no
// external mock server required.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 because the test:
//   - requires a working podman environment (Mac or Linux),
//   - builds/uses the core sandbox image (~minutes on first run),
//   - starts the openshell gateway,
//   - creates and tears down a real container.
//
// The mechanism (harness selector -> exec adapter -> policy routing) is
// statically covered by unit tests in src/sandbox/harness.test.ts,
// src/sandbox/container.test.ts, and src/sandbox/session.test.ts. This
// test closes the loop end-to-end for the cred_inject axis.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  containerfileKeyForCaps,
  DEFAULT_CONTAINERFILES,
} from "../../src/sandbox/default-containerfiles";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { ensureImage } from "../../src/sandbox/image-build";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const PROVIDER_NAME = "openlock-test-echo";
const SECRET_VALUE = "smoke-value-12345";
const FIXTURE_POLICY = resolve(__dirname, "../fixtures/policies/test-harness-mechanism.yaml");

async function spawnAndCapture(
  argv: string[],
  cwd?: string,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: extraEnv === undefined ? undefined : { ...process.env, ...extraEnv },
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

describe("harness cred_inject mechanism (live integration)", () => {
  it.skipIf(!LIVE)(
    "opencode policy + cred_inject rewrites headers via proxy echo mode",
    async () => {
      const sessionName = `openlock-test-${Date.now().toString(36)}`;
      const containerName = `openlock-sb-${sessionName}`;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-it-"));
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
        await spawnAndCapture(["podman", "rm", "-f", containerName]);
      };

      try {
        await startGateway();

        // Recreate provider idempotently (delete first if it exists).
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

        // EH8-DIAG: timestamps + proxy-bind probe via bash /dev/tcp. Verifies
        // the openlock-eh8 hypothesis that ssh exit 56 stems from supervisor
        // proxy 3128 not yet bound when foreground exec starts.
        const curlCmd =
          'echo "EH8 T0=$(date +%s.%N)" >&2; ' +
          "for i in $(seq 1 60); do " +
          "if (echo > /dev/tcp/10.200.0.1/3128) 2>/dev/null; then " +
          'echo "EH8 PROXY-BOUND T${i}s=$(date +%s.%N)" >&2; break; ' +
          "fi; sleep 1; done; " +
          'echo "EH8 PRE-CURL=$(date +%s.%N)" >&2; ' +
          'curl -sf -H "X-Original-Header: original-value" https://mock.opencode.test:8443/; ' +
          'echo "EH8 POST-CURL=$(date +%s.%N) curl=$?" >&2';

        const sandboxArgv = [
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
          "/bin/bash",
          "-c",
          curlCmd,
        ];

        const result = await spawnAndCapture(sandboxArgv, cli.cwd, {
          OPENSHELL_SSH_LOG_LEVEL: "DEBUG",
        });
        // EH8-DIAG: always dump for diagnostic capture (pass and fail).
        console.log(`EH8 result.code=${result.code}`);
        console.log(`EH8 result.stderr=\n${result.stderr}`);
        console.log(`EH8 result.stdout-len=${result.stdout.length}`);
        // openshell exit code reflects the foreground command; the curl
        // output (echo JSON) is what we parse.
        const jsonStart = result.stdout.indexOf("{");
        if (jsonStart === -1) {
          throw new Error(
            `no JSON in stdout (code=${result.code}); stdout=${result.stdout}; stderr=${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.slice(jsonStart));

        expect(parsed.echo).toBe(true);
        expect(parsed.cred_inject_applied).toBe(true);
        // X-Test-Echo injected from TEST_ECHO_VAL.
        const headers = parsed.headers as Record<string, string>;
        const headerKeys = Object.keys(headers);
        const xTestEcho = headerKeys.find((k) => k.toLowerCase() === "x-test-echo");
        expect(xTestEcho).toBeTruthy();
        expect(xTestEcho && headers[xTestEcho]).toBe(SECRET_VALUE);
        // X-Original-Header stripped.
        const xOriginal = headerKeys.find((k) => k.toLowerCase() === "x-original-header");
        expect(xOriginal).toBeUndefined();
      } finally {
        await removeContainer();
        await removeProvider();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
