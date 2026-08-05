// Integration test: scoped npm packages (@scope/name) install via the
// default-js policy. Regression coverage for openlock-isb (bug closed
// 2026-05-20): npm's REST API encodes the scope slash as %2F, which the
// openshell-fork L7 canonicalizer rejects unless the endpoint sets
// `allow_encoded_slash: true`. Without the opt-in, every scoped install
// fails. With it, the request reaches the registry.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 (same rationale as
// harness-cred-inject.test.ts: needs podman + image build + gateway).

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicyContent } from "../../src/sandbox/default-policies";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";

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
  const commit = await spawnAndCapture(
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
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
}

/**
 * True when `sandbox delete` failed only because the sandbox doesn't exist
 * — a harmless "nothing to clean up" outcome (e.g. the test died before
 * ever creating one), not a leak. Matches the literal stderr text from a
 * verified live probe against the real gateway (2026-08-05): `openshell
 * sandbox delete <nonexistent>` exits 1 with stderr `Error:   × code: 'Some
 * requested entity was not found', message: "sandbox not found"`. A
 * sandbox that still EXISTS and can't be removed (the real leak signature
 * — e.g. "attached to sandbox(es)") does not match this and stays loud.
 * (Contrast `provider delete` on a nonexistent name, which is already exit
 * 0 — no matcher needed there.)
 */
function isSandboxNotFoundError(stderr: string): boolean {
  return stderr.includes("sandbox not found");
}

describe("npm scoped packages via default-js policy", () => {
  // openlock-18c: see harness-binary-cred-inject.test.ts for the full
  // mechanism writeup (bun test timeout runs afterEach/afterAll but not an
  // in-body try/finally). Also fixes the same second bug as its siblings:
  // `removeContainer` did a raw `podman rm -f`, never `sandbox delete`,
  // leaving the gateway's own sandbox record behind even on a clean run.
  // No provider is created in this test, so only the sandbox is registered.
  // NOT a prefix sweep — only the exact name this run registers is ever
  // deleted; this suite runs against the real dev gateway.
  let registeredSandbox: string | null = null;

  afterAll(
    async () => {
      if (registeredSandbox === null) return;
      const cli = await getCliInvocation();
      const r = await spawnAndCapture(
        [...cli.argv, "sandbox", "delete", registeredSandbox],
        cli.cwd,
      );
      if (r.code !== 0 && !isSandboxNotFoundError(r.stderr)) {
        throw new Error(
          `openlock-18c: gateway teardown left leaked state behind: sandbox delete ` +
            `${registeredSandbox} failed (exit ${r.code}): ${r.stderr}`,
        );
      }
    },
    // openlock-18c: explicit timeout required — hooks default to 5000ms
    // regardless of the `it`'s own budget, and podman teardown exceeds that.
    // See harness-binary-cred-inject.test.ts's afterAll for the full story.
    120_000,
  );

  it.skipIf(!LIVE)(
    "fetch of @scope%2Fname is allowed (allow_encoded_slash: true on npm endpoint)",
    async () => {
      const sessionName = `ol-npm-${Date.now().toString(36)}`;
      registeredSandbox = sessionName;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-isb-"));
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir);
      await gitInit(repoDir);

      const staging = join(tmp, "staging", ".openlock");
      mkdirSync(staging, { recursive: true });
      await createBundle(repoDir, join(staging, "repo.bundle"));

      const policyPath = join(tmp, "policy.yaml");
      writeFileSync(policyPath, defaultPolicyContent());

      const cli = await getCliInvocation();
      const argvHead = cli.argv;

      try {
        await startGateway();

        const image = await ensureImage({
          containerfileContent: BASE_CONTAINERFILE,
          tagPrefix: "openlock-base-it",
        });

        // Fetch scoped-package metadata via npm. npm encodes the slash:
        // GET /@opencode-ai%2Fplugin. Pre-fix this gets canonicalizer-
        // rejected with "request-target contains an encoded '/'". Post-fix
        // npm prints the package version and exits 0.
        const probeCmd =
          "npm view @opencode-ai/plugin version --cache /tmp/npm-cache --no-update-notifier --no-fund --no-audit";

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
          policyPath,
          "--no-tty",
          "--",
          "/bin/bash",
          "-c",
          probeCmd,
        ];

        const result = await spawnAndCapture(sandboxArgv, cli.cwd);
        expect(result.code).toBe(0);
        // npm view prints just the version string on stdout.
        expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
      } finally {
        // Gateway-side sandbox cleanup lives in the describe's `afterAll`
        // above, which survives a timeout this `finally` would not — see
        // openlock-18c comment there.
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
