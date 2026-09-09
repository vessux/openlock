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

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOpenshellExecArgv } from "../../src/sandbox/container";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";
import { teardownGatewayState } from "./helpers/gateway-teardown";
import { createDetachedSandbox, spawnAndCapture } from "./helpers/sandbox-lifecycle";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const PROVIDER_NAME = "openlock-test-hnp";
const SECRET_VALUE = "post-create-secret-12345";
const FIXTURE_POLICY = resolve(__dirname, "../fixtures/policies/test-harness-mechanism.yaml");

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

describe("post-create harness exec routes via proxy (openlock-hnp)", () => {
  // openlock-18c: see harness-binary-cred-inject.test.ts for the full
  // mechanism writeup (bun test timeout runs afterEach/afterAll but not an
  // in-body try/finally). Also fixes the same second bug as its siblings:
  // `removeContainer` did a raw `podman rm -f`, never `sandbox delete`,
  // leaving the gateway's own sandbox record behind even on a clean run.
  // Fork v0.9.0 (#2726): `sandbox create --detach` returns once the sandbox
  // exists rather than staying attached to a foreground command, so unlike
  // the pre-#2726 world there is no longer a long-lived `create` child
  // process for this suite to track/reap — `createDetachedSandbox` (below)
  // owns the whole create-then-wait-for-Ready sequence and returns once it's
  // done. NOT a prefix sweep — only the exact name(s) this run registers are
  // ever deleted; this suite runs against the real dev gateway.
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
    "buildOpenshellExecArgv path enforces proxy + cred_inject post-create",
    async () => {
      const sessionName = `ol-hnp-${Date.now().toString(36)}`;
      registeredSandbox = sessionName;
      registeredProvider = PROVIDER_NAME;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-hnp-"));
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir);
      await gitInit(repoDir);

      const cli = await getCliInvocation();
      const argvHead = cli.argv;
      const removeProvider = async (): Promise<void> => {
        // Best-effort, pre-create only (may not exist yet). The `afterAll`
        // teardown above is the strict path.
        await spawnAndCapture([...argvHead, "provider", "delete", PROVIDER_NAME], cli.cwd);
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

        const image = await ensureImage({
          containerfileContent: BASE_CONTAINERFILE,
          tagPrefix: "openlock-base-it",
        });

        // Create a long-running sandbox: the main process (fork v0.9.0
        // #2726's canonical main process) sleeps; the command we exec
        // post-create is the actual network-emitting process. This mirrors
        // the openlock attach path. `createDetachedSandbox` runs `sandbox
        // create --detach` (returns once the sandbox exists, not once the
        // main process exits) and polls until Ready.
        await createDetachedSandbox(
          argvHead,
          {
            name: sessionName,
            image: image.tag,
            policy: FIXTURE_POLICY,
            providers: [PROVIDER_NAME],
          },
          cli.cwd,
        );

        // The fix under test: post-create exec via openshell sandbox exec.
        // If openlock-hnp regressed (raw podman exec), curl would talk to
        // mock.opencode.test directly, fail DNS or be denied, and no echo
        // JSON would come back.
        // --retry 5 + --retry-all-errors absorbs the transient TLS/recv race
        // (curl exit 35/56) when the FIRST post-create egress beats the
        // supervisor's CA-bundle + echo-proxy bring-up. waitForSandboxReady
        // only proves /bin/true execs — NOT that egress is wired — so the
        // first proxied request can still race. -S surfaces curl's real error
        // if all retries are exhausted (so a true failure is no longer blind).
        // Matches the sibling foreground tests (harness-cred-inject,
        // openrouter-opencode-cred-inject). bd openlock-eh8.
        const curlArgv = [
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
      } finally {
        // Gateway-side cleanup (sandbox, provider) lives in the describe's
        // `afterAll` above, which survives a timeout this `finally` would
        // not — see openlock-18c comment there.
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
