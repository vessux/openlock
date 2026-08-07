// Shared gateway-side teardown machinery for the live-integration suite
// (OPENLOCK_LIVE_INTEGRATION=1).
//
// EXTRACTED (bd openlock-qaed) from 5 near-identical inline copies that had
// drifted apart only in comment verbosity, never in behavior:
// harness-cred-inject.test.ts, post-create-openrouter-real.test.ts,
// post-create-exec-proxy.test.ts, harness-binary-cred-inject.test.ts,
// openrouter-opencode-cred-inject.test.ts. npm-scoped-pkg.test.ts never
// received the pattern in the first place — its `afterAll` issued `sandbox
// delete` and returned without ever waiting for the gateway's async
// teardown to land, which is exactly the openlock-qaed leak (`ol-npm-*`
// residue tripping the openlock-n73d gateway-clean CI check even though the
// owning test PASSED). There was nothing for that file to fall through to;
// this module is that "to".
//
// Every live-integration test that creates a sandbox and/or provider against
// the real dev gateway should register the name(s) it creates and call
// `teardownGatewayState` from a describe-scoped `afterAll` with an explicit
// 120_000ms timeout — hooks do NOT inherit an `it`'s own timeout budget (bun
// defaults every hook to 5000ms regardless of the test's budget), and the
// wait for the async `sandbox delete` to land (up to 60s, see
// `waitForSandboxGone` below) plus podman teardown can exceed that.

import { getSandboxState } from "../../../src/sandbox/container";

export interface CliInvocation {
  argv: string[];
  cwd: string | undefined;
}

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
export function isSandboxNotFoundError(stderr: string): boolean {
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
 *
 * openlock-qaed: this wait — not just the ordering, not just the exit code
 * — is the whole fix. A CI log pulled for the `ol-npm-*` leak showed ~30s
 * elapse between the plain (non-waiting) delete call and the residue check
 * still finding the sandbox listed, comfortably inside this function's own
 * 60s default budget for "async teardown, still in flight."
 */
export async function waitForSandboxGone(name: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getSandboxState(name)) === "missing") return;
    await Bun.sleep(750);
  }
  throw new Error(
    `openlock-18c: sandbox ${name} still not reported gone ${timeoutMs}ms after ` +
      `its delete was accepted. If this run also registered a provider, its ` +
      `delete is skipped to avoid a second, misleading "attached to ` +
      `sandbox(es)" error masking this one`,
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
export async function deleteSandboxAndWait(
  cli: CliInvocation,
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
 * `isSandboxNotFoundError`.
 *
 * `sandboxName` and `providerName` are each independently optional: pass
 * `null` for a test that never creates one. `npm-scoped-pkg.test.ts` never
 * creates a provider, so it always passes `providerName: null` — provider
 * teardown is skipped entirely rather than assumed.
 *
 * Loud on purpose: a silently-discarded teardown failure is exactly what
 * let leaked gateway state poison the next run. Throwing here fails the
 * suite instead of hiding it.
 */
export async function teardownGatewayState(
  cli: CliInvocation,
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
  if (errors.length > 0) {
    throw new Error(
      `openlock-18c: gateway teardown left leaked state behind:\n${errors.join("\n")}`,
    );
  }
}
