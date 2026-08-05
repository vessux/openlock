// Live integration test: proves cred_inject applies when the claude
// harness binary itself makes the outbound request, not when a generic
// HTTP client (curl/python) does. Distinguishes from
// tests/integration/harness-cred-inject.test.ts which uses curl as the
// requester — `/usr/bin/curl` becomes the matched binary, the harness
// binary entry in the policy is decorative.
//
// Here the foreground command IS the claude binary. /usr/local/bin/claude
// resolves through symlinks to claude.exe — the proxy resolves these
// symlinks at sandbox boot (see "Resolved policy binary symlink" log
// lines) so the policy's binary list matches the actual executable.
// Assertion is on the proxy's OCSF log, fetched via the openshell `logs`
// RPC after the sandbox exits: at least one HTTP ALLOWED event tied to
// our test policy proves the L7 path (and thus cred_inject) ran.
//
// Opencode is intentionally not covered here. Its boot needs reachable
// models.dev + github.com before issuing /v1/messages; synthetic echo
// for those breaks opencode's parsing, and skipping them prevents the
// messages call. The opencode half was verified manually (bd-zm4
// 2026-05-19 comment) and routing is covered by upstream-fork OPA tests.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 because the test:
//   - requires a working podman environment (Mac or Linux),
//   - builds/uses the core sandbox image (~minutes on first run),
//   - starts the openshell gateway,
//   - runs the real harness binary (which may attempt unrelated
//     telemetry / update / model-list calls that get denied by the
//     restrictive policy — denials are expected and ignored).

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getSandboxState } from "../../src/sandbox/container";
import { computeBaseTag, GHCR_BASE_PREFIX } from "../../src/sandbox/ensure-base";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { BASE_CONTAINERFILE, ensureSandbox } from "../../src/sandbox/image-build";
import { seedContainerfile } from "../../src/sandbox/seed-containerfile";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const SECRET_VALUE = "smoke-value-harness-binary";
const FIXTURE_POLICY = resolve(__dirname, "../fixtures/policies/test-harness-binary-trigger.yaml");
const POLICY_NAME = "claude_harness_test";

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
 * openlock-18c DISCOVERY — the reason sandbox-before-provider ordering alone
 * is NOT sufficient: `sandbox delete` returns exit 0 when the gateway
 * ACCEPTS the delete, not when it COMPLETES. The gateway tears the sandbox
 * down ASYNCHRONOUSLY, and a provider stays "attached to sandbox(es)" until
 * that finishes. Observed live in CI on podman (job 92302866248):
 * `sandbox delete ol-echo-<x>` returned exit 0, then microseconds later
 * `provider delete openlock-test-echo` failed with `provider
 * 'openlock-test-echo' is attached to sandbox(es): ol-echo-<x>` — the exact
 * leaked-state error this teardown exists to prevent. Docker's teardown
 * lands fast enough to hide this race — a docker-leg pass is NOT evidence
 * this wait is unnecessary. DO NOT "simplify" this wait away: the ordering
 * alone looks sufficient and demonstrably is not.
 *
 * Polls `getSandboxState` (src/sandbox/container.ts) until it reports
 * "missing" — the gateway AFFIRMATIVELY saying the sandbox is gone.
 * Deliberately not "anything other than the delete having been issued":
 * `getSandboxState` also returns "unreachable" for a transport hiccup
 * (openlock-vtl), which is explicitly NOT proof of absence and must keep
 * polling, never be mistaken for gone.
 */
async function waitForSandboxGone(name: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getSandboxState(name)) === "missing") return;
    await Bun.sleep(750);
  }
  throw new Error(
    `openlock-18c: sandbox ${name} still not reported gone ${timeoutMs}ms after ` +
      `its delete was accepted — skipping the provider delete to avoid a ` +
      `second, misleading "attached to sandbox(es)" error`,
  );
}

/**
 * Deletes one sandbox and, if the delete was ACCEPTED (exit 0 — not a
 * not-found no-op), waits for it to actually land before the caller touches
 * the provider — see `waitForSandboxGone`'s doc for why this wait exists.
 * `skipProviderDelete: true` only when that wait times out, so the caller
 * doesn't fall through and attempt a provider delete that would just
 * produce a second, confusing error against a sandbox already known to
 * still be there.
 */
async function deleteSandboxAndWait(
  cli: { argv: string[]; cwd: string | undefined },
  sandboxName: string,
): Promise<{ error: string | null; skipProviderDelete: boolean }> {
  const r = await spawnAndCapture([...cli.argv, "sandbox", "delete", sandboxName], cli.cwd);
  if (r.code !== 0 && !isSandboxNotFoundError(r.stderr)) {
    return {
      error: `sandbox delete ${sandboxName} failed (exit ${r.code}): ${r.stderr}`,
      skipProviderDelete: false,
    };
  }
  if (r.code !== 0) return { error: null, skipProviderDelete: false }; // not-found — nothing to wait for.
  try {
    await waitForSandboxGone(sandboxName);
    return { error: null, skipProviderDelete: false };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), skipProviderDelete: true };
  }
}

/**
 * Strict, loud gateway-side teardown (openlock-18c): deletes only the exact
 * sandbox/provider names THIS run registered — never a prefix sweep, since
 * this suite runs against the real dev gateway — sandbox-before-provider,
 * WAITING for the sandbox's async teardown to land (see
 * `deleteSandboxAndWait`/`waitForSandboxGone`) before the provider delete
 * that would otherwise race it, and throws on any real failure instead of
 * discarding it. A sandbox-delete that fails only because there was never
 * one to delete (the test died before creating it) is NOT an error — see
 * `isSandboxNotFoundError`. Split out of `afterAll` purely to keep that
 * hook's cognitive complexity under biome's limit.
 */
async function teardownGatewayState(
  cli: { argv: string[]; cwd: string | undefined },
  sandboxName: string | null,
  providerName: string | null,
): Promise<void> {
  const errors: string[] = [];
  let skipProviderDelete = false;
  if (sandboxName !== null) {
    const outcome = await deleteSandboxAndWait(cli, sandboxName);
    if (outcome.error !== null) errors.push(outcome.error);
    skipProviderDelete = outcome.skipProviderDelete;
  }
  if (providerName !== null && !skipProviderDelete) {
    const r = await spawnAndCapture([...cli.argv, "provider", "delete", providerName], cli.cwd);
    if (r.code !== 0) {
      errors.push(`provider delete ${providerName} failed (exit ${r.code}): ${r.stderr}`);
    }
  }
  // Loud on purpose (openlock-18c): a silently-discarded teardown failure is
  // exactly what let leaked gateway state poison the next run. Throwing here
  // fails the suite instead of hiding it.
  if (errors.length > 0) {
    throw new Error(
      `openlock-18c: gateway teardown left leaked state behind:\n${errors.join("\n")}`,
    );
  }
}

async function gitInit(dir: string): Promise<void> {
  const init = await spawnAndCapture(["git", "init", "-q", "-b", "main"], dir);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
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

describe("harness binary triggers cred_inject (live integration)", () => {
  // openlock-18c: a bun test timeout runs afterEach/afterAll but NOT an
  // in-body try/finally (verified empirically — see the bd issue), so the
  // cleanup below used to live in a `finally` that a timed-out run (this
  // test's network-dependent budget is 180s) silently skipped, leaking the
  // sandbox and — since `openshell provider delete` refuses a provider still
  // "attached to sandbox(es)" — the provider behind it too. Registered here
  // (module-scoped, populated by the test body once the dynamic sandbox name
  // is known) and torn down unconditionally in `afterAll`, sandbox-before-
  // provider, with both results checked. NOT a prefix sweep: only the exact
  // name(s) this run itself registers are ever deleted — this suite runs
  // against the developer's real dev gateway.
  let registeredSandbox: string | null = null;
  let registeredProvider: string | null = null;

  afterAll(
    async () => {
      // Skip entirely (no getCliInvocation() call, which can hit the network
      // in non-dev-mode) when the LIVE test never ran/never got far enough to
      // register anything — the common case under plain `bun run test`.
      if (registeredSandbox === null && registeredProvider === null) return;
      const cli = await getCliInvocation();
      await teardownGatewayState(cli, registeredSandbox, registeredProvider);
    },
    // openlock-18c: hooks do NOT inherit the `it`'s own timeout (180_000
    // below) — bun defaults EVERY hook to 5000ms regardless of the test's
    // budget. Podman sandbox teardown (`openshell sandbox delete`) routinely
    // exceeds that, so the default silently CUT OFF this afterAll mid-delete
    // (observed as "killed 2 dangling processes" + 5 hook-timeout failures
    // in CI, docker's leg passed only because docker is faster — not
    // evidence of correctness). That's worse than a red check: a cut-off
    // delete can leave exactly the leaked state this hook exists to prevent.
    // 120_000 matches the lower end of this file's `it` budgets; teardown is
    // 2 CLI calls, so this is headroom, not a real wait.
    120_000,
  );

  it.skipIf(!LIVE)(
    `claude_code: /usr/local/bin/claude runs L7 echo via ${POLICY_NAME}`,
    async () => {
      const sessionName = `ol-hb-${Date.now().toString(36)}`;
      const providerName = "openlock-test-hb-claude";
      registeredSandbox = sessionName;
      registeredProvider = providerName;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-hb-"));
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir);
      await gitInit(repoDir);

      const staging = join(tmp, "staging", ".openlock");
      mkdirSync(staging, { recursive: true });
      await createBundle(repoDir, join(staging, "repo.bundle"));

      const cli = await getCliInvocation();
      const argvHead = cli.argv;
      const removeProvider = async (): Promise<void> => {
        // Best-effort, pre-create only: tolerate a non-zero exit (provider
        // may not exist yet). The teardown path above is the strict one.
        await spawnAndCapture([...argvHead, "provider", "delete", providerName], cli.cwd);
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
            providerName,
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

        const baseHash = computeBaseTag(BASE_CONTAINERFILE).slice(GHCR_BASE_PREFIX.length);
        const userContainerfile = seedContainerfile({
          harnesses: ["claude_code"],
          baseHash,
          baseContent: BASE_CONTAINERFILE,
        });
        const imageTag = await ensureSandbox(userContainerfile);

        // Run claude with a fake API key and a one-shot prompt — it
        // will issue HTTP requests against api.anthropic.com which the
        // proxy intercepts via echo mode. The harness errors on the
        // unrecognized response, exit code is suppressed by `|| true`.
        //
        // 3-attempt loop covers a startup race where claude can fire
        // before the supervisor's ephemeral CA + proxy listener finish
        // wiring, leading to a fast-fail with no L7 ALLOWED event in
        // the proxy log. Loop stops on the first non-error claude exit.
        const innerCmd =
          'for i in 1 2 3; do ANTHROPIC_API_KEY=fake-key /usr/local/bin/claude --print "hi" && break; sleep 1; done || true';

        const sandboxArgv = [
          ...argvHead,
          "sandbox",
          "create",
          "--name",
          sessionName,
          "--from",
          imageTag,
          "--upload",
          `${join(tmp, "staging")}:/sandbox/`,
          "--no-git-ignore",
          "--policy",
          FIXTURE_POLICY,
          "--provider",
          providerName,
          "--no-tty",
          "--",
          "/bin/bash",
          "-c",
          innerCmd,
        ];

        await spawnAndCapture(sandboxArgv, cli.cwd);

        // Fetch sandbox logs (OCSF shorthand) before sandbox cleanup.
        const logsResult = await spawnAndCapture(
          [...argvHead, "logs", sessionName, "-n", "2000"],
          cli.cwd,
        );
        const logs = logsResult.stdout;

        // The fixture policy allows GET/POST on /** so every claude
        // HTTP request to api.anthropic.com lands as ALLOWED with
        // cred_inject applied. The L7 event (HTTP:METHOD ALLOWED) only
        // emits when the request reaches the cred_inject branch — an
        // L4-denied connect produces no HTTP event. We require at
        // least one such line scoped to our test policy.
        //
        // The endpoint match parses the OCSF shorthand token
        // `http://<host>:<port>/<path>` from the log line. Splitting on
        // whitespace and matching token equality (rather than
        // `String.includes` or a loose regex) avoids the CodeQL
        // incomplete-URL-substring-sanitization heuristic — this is
        // log-line parsing, not URL validation.
        const lines = logs.split("\n");
        const matchesEndpoint = (line: string): boolean => {
          for (const tok of line.split(/\s+/)) {
            if (tok.startsWith("http://api.anthropic.com:443/")) return true;
          }
          return false;
        };
        const l7Hits = lines.filter(
          (l) =>
            l.includes(POLICY_NAME) &&
            matchesEndpoint(l) &&
            /\bHTTP:[A-Z]+\b/.test(l) &&
            /ALLOWED/.test(l),
        );
        if (l7Hits.length === 0) {
          // Surface a small slice of the OCSF stream for debugging
          // without flooding the bun test reporter.
          const tail = lines.filter((l) => l.includes("[OCSF")).slice(-25);
          console.error(`no L7 ALLOWED for ${POLICY_NAME} — last 25 OCSF lines:`);
          for (const l of tail) console.error(l);
        }
        expect(l7Hits.length).toBeGreaterThan(0);
      } finally {
        // Gateway-side cleanup (sandbox + provider) now lives in the
        // describe's `afterAll` above, which survives a timeout that skips
        // this `finally` — see openlock-18c comment there. The tmp dir is
        // harmless either way (plain host-side scratch), so it stays here.
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
