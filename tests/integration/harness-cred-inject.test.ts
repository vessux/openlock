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

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";
import { teardownGatewayState } from "./helpers/gateway-teardown";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const PROVIDER_NAME = "openlock-test-echo";
const SECRET_VALUE = "smoke-value-12345";
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

describe("harness cred_inject mechanism (live integration)", () => {
  // openlock-18c: a bun test timeout runs afterEach/afterAll but NOT an
  // in-body try/finally (verified empirically — see the bd issue and the
  // fuller comment in harness-binary-cred-inject.test.ts), so cleanup lives
  // here instead, keyed off names the test body registers as it creates
  // them. Also fixes a second bug while here: the old `removeContainer` did
  // a raw `podman rm -f` on the container, never `sandbox delete` — that
  // left the gateway's OWN sandbox record behind (Phase stuck at whatever it
  // last was) even on a clean run, which is what let `openlock-test-echo`
  // stay "attached to sandbox(es)" and refuse deletion. `sandbox delete`
  // tears down both. NOT a prefix sweep — only the exact name(s) this run
  // registers are ever deleted; this suite runs against the real dev
  // gateway.
  let registeredSandbox: string | null = null;
  let registeredProvider: string | null = null;

  afterAll(
    async () => {
      if (registeredSandbox === null && registeredProvider === null) return;
      const cli = await getCliInvocation();
      await teardownGatewayState(cli, registeredSandbox, registeredProvider);
    },
    // openlock-18c: explicit timeout required — hooks default to 5000ms
    // regardless of the `it`'s own budget, and podman teardown exceeds that.
    // See harness-binary-cred-inject.test.ts's afterAll for the full story.
    120_000,
  );

  it.skipIf(!LIVE)(
    "opencode policy + cred_inject rewrites headers via proxy echo mode",
    async () => {
      const sessionName = `ol-echo-${Date.now().toString(36)}`;
      registeredSandbox = sessionName;
      registeredProvider = PROVIDER_NAME;
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
        // Best-effort, pre-create only (may not exist yet). The `afterAll`
        // teardown above is the strict path.
        await spawnAndCapture([...argvHead, "provider", "delete", PROVIDER_NAME], cli.cwd);
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

        const image = await ensureImage({
          containerfileContent: BASE_CONTAINERFILE,
          tagPrefix: "openlock-base-it",
        });

        // --retry 5 + --retry-all-errors covers transient TLS/network
        // failures (exit 35/56) seen when curl races the supervisor's
        // CA-bundle + echo-proxy bring-up. ~5s worst-case extra.
        const curlCmd = [
          "curl",
          "-sSf",
          "--retry",
          "5",
          "--retry-all-errors",
          "--retry-delay",
          "1",
          "-H",
          "X-Original-Header: original-value",
          "https://mock.opencode.test:8443/",
        ].join(" ");

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

        const result = await spawnAndCapture(sandboxArgv, cli.cwd);
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
        // Gateway-side cleanup (sandbox + provider) lives in the describe's
        // `afterAll` above, which survives a timeout this `finally` would
        // not — see openlock-18c comment there.
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
