// Integration test: validates that cred_inject applies to the openrouter
// provider by routing a request from inside the sandbox through the proxy's
// `echo: true` endpoint mode. The proxy intercepts the CONNECT, runs the
// full strip-and-replace pipeline, and returns the post-rewrite headers as
// JSON instead of forwarding upstream — no external mock server and no real
// OpenRouter API key required.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 because the test:
//   - requires a working podman environment (Mac or Linux),
//   - builds/uses the core sandbox image (~minutes on first run),
//   - starts the openshell gateway,
//   - creates and tears down a real container.
//
// The mechanism (provider plugin -> cred_inject -> policy routing) is
// statically covered by unit tests in src/providers/openrouter.test.ts and
// scripts/render-default-policies.test.ts. This test closes the loop
// end-to-end for the cred_inject axis of the openrouter provider.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const PROVIDER_NAME = "openlock-test-openrouter";
const SECRET_VALUE = "Bearer sk-or-test-value-mock-12345";
const FIXTURE_POLICY = resolve(__dirname, "../fixtures/policies/test-openrouter-mechanism.yaml");

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

/**
 * Strict, loud gateway-side teardown (openlock-18c): deletes only the exact
 * sandbox/provider names THIS run registered — never a prefix sweep, since
 * this suite runs against the real dev gateway — sandbox-before-provider (a
 * provider still "attached to sandbox(es)" refuses deletion), and throws on
 * any real failure instead of discarding it. A sandbox-delete that fails only
 * because there was never one to delete (the test died before creating it)
 * is NOT an error — see `isSandboxNotFoundError`. Split out of `afterAll`
 * purely to keep that hook's cognitive complexity under biome's limit.
 */
async function teardownGatewayState(
  cli: { argv: string[]; cwd: string | undefined },
  sandboxName: string | null,
  providerName: string | null,
): Promise<void> {
  const errors: string[] = [];
  if (sandboxName !== null) {
    const r = await spawnAndCapture([...cli.argv, "sandbox", "delete", sandboxName], cli.cwd);
    if (r.code !== 0 && !isSandboxNotFoundError(r.stderr)) {
      errors.push(`sandbox delete ${sandboxName} failed (exit ${r.code}): ${r.stderr}`);
    }
  }
  if (providerName !== null) {
    const r = await spawnAndCapture([...cli.argv, "provider", "delete", providerName], cli.cwd);
    if (r.code !== 0) {
      errors.push(`provider delete ${providerName} failed (exit ${r.code}): ${r.stderr}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `openlock-18c: gateway teardown left leaked state behind:\n${errors.join("\n")}`,
    );
  }
}

describe("openrouter cred_inject mechanism (live integration)", () => {
  // openlock-18c: see harness-binary-cred-inject.test.ts for the full
  // mechanism writeup (bun test timeout runs afterEach/afterAll but not an
  // in-body try/finally). Also fixes the same second bug as
  // harness-cred-inject.test.ts: `removeContainer` did a raw `podman rm -f`,
  // never `sandbox delete`, leaving the gateway's own sandbox record behind
  // even on a clean run. NOT a prefix sweep — only the exact name(s) this
  // run registers are ever deleted; this suite runs against the real dev
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
    "openrouter policy + cred_inject rewrites Authorization header via proxy echo mode",
    async () => {
      const sessionName = `ol-or-${Date.now().toString(36)}`;
      registeredSandbox = sessionName;
      registeredProvider = PROVIDER_NAME;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-or-it-"));
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
            `OPENROUTER_BEARER_TOKEN=${SECRET_VALUE}`,
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
          "-X",
          "POST",
          "-H",
          "Authorization: Bearer fake",
          "-H",
          "X-Original-Header: original-value",
          "https://mock.openrouter.test:8443/api/v1/chat/completions",
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
        // Authorization header rewritten from "Bearer fake" to SECRET_VALUE.
        const headers = parsed.headers as Record<string, string>;
        const headerKeys = Object.keys(headers);
        const authKey = headerKeys.find((k) => k.toLowerCase() === "authorization");
        expect(authKey).toBeTruthy();
        expect(authKey && headers[authKey]).toBe(SECRET_VALUE);
        // X-Original-Header stripped by cred_inject strip_headers list.
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
