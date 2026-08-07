// Anti-false-green guard for the OPENLOCK_DISPOSABLE_HOST marker
// (bd openlock-o4t4).
//
// WHY THIS FILE EXISTS: a gated test that silently never runs is a
// permanent false green — this project has been bitten by exactly that
// shape before (bun:test's own timeout-skips-afterAll/finally footgun,
// the openlock-18c leak, the n73d residue check that exists because
// nothing asserted the leak-fix kept working). The disposable-host marker
// has the identical failure shape: if a future edit to
// .github/workflows/test.yml's `live-integration` job drops the
// `OPENLOCK_DISPOSABLE_HOST: "1"` env var, every test that calls
// `requireDisposableHost` would start throwing (loud, good) — but a test
// that instead used `isDisposableHost()` to `it.skipIf` itself would start
// SILENTLY SKIPPING instead, and the job would stay green. This file turns
// that specific regression into a red, independent of whether any
// individual gated test currently exists (per this PR's own scope, none
// does yet — this ships the mechanism and this guard together).
//
// THE FILTER — deciding "are we inside the live-integration CI job right
// now" — is the part most likely to be gotten wrong in a way that makes
// this guard assert nothing. Two signals, both necessary:
//   - OPENLOCK_LIVE_INTEGRATION === "1": set only by the live-integration
//     job's "Integration tests" step (test.yml). Never set in the plain
//     `test` job. Can be set locally by a developer running
//     `OPENLOCK_LIVE_INTEGRATION=1 bun test tests/integration/` — LIVE
//     alone is NOT sufficient to conclude "we are in CI".
//   - CI is set (GitHub Actions sets `CI=true` on every workflow run,
//     including the plain `test` job): true in BOTH jobs, but never true
//     on a developer's own machine — CI alone is NOT sufficient either,
//     since the plain `test` job also runs this very file (`bun run test`
//     is `bun test ./src/ ./tests/ ./scripts/`, which includes
//     tests/integration/) and never sets the marker, by design.
// Only the AND of both narrows to exactly the live-integration job. Each
// half is exercised in isolation below against a pure decision function,
// so a regression in the filter itself (not just in the marker) is caught
// by this suite everywhere it runs — not only inside live-integration,
// where a broken filter would otherwise hide behind "well it passed."
import { describe, expect, it } from "bun:test";
import { isDisposableHost } from "./helpers/disposable-host";

/**
 * Pure, exported-for-testing decision function: true exactly when the
 * current process is the live-integration CI job. Kept separate from the
 * `it.skipIf` call site below so its truth table can be asserted directly
 * against synthetic inputs, independent of whichever job happens to be
 * running this file today.
 */
export function isLiveIntegrationCi(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CI) && env.OPENLOCK_LIVE_INTEGRATION === "1";
}

describe("isLiveIntegrationCi filter — self-test, runs in every job (bd openlock-o4t4)", () => {
  it("is true when both CI is set and OPENLOCK_LIVE_INTEGRATION is exactly '1' (the live-integration job's shape)", () => {
    expect(isLiveIntegrationCi({ CI: "true", OPENLOCK_LIVE_INTEGRATION: "1" })).toBe(true);
  });

  it("is false with CI set but LIVE unset (the plain `test` job's shape)", () => {
    expect(isLiveIntegrationCi({ CI: "true" })).toBe(false);
  });

  it("is false with LIVE set but CI unset (a developer's own local live-integration run)", () => {
    expect(isLiveIntegrationCi({ OPENLOCK_LIVE_INTEGRATION: "1" })).toBe(false);
  });

  it("is false with neither set (plain local `bun run test`)", () => {
    expect(isLiveIntegrationCi({})).toBe(false);
  });

  it("is false when LIVE is truthy-looking but not exactly '1'", () => {
    expect(isLiveIntegrationCi({ CI: "true", OPENLOCK_LIVE_INTEGRATION: "true" })).toBe(false);
  });
});

describe("OPENLOCK_DISPOSABLE_HOST is asserted by the live-integration CI job (bd openlock-o4t4)", () => {
  // Evaluated once at collection time against the REAL environment this
  // file is actually running under — this is the guard itself, not a
  // synthetic-input self-test. it.skipIf(true) means "this environment is
  // not the live-integration job; nothing to assert here" (matches every
  // other job/local run). it.skipIf(false) — i.e. only inside the actual
  // live-integration job — means the assertion below MUST run and MUST
  // pass, or the job goes red.
  it.skipIf(!isLiveIntegrationCi(process.env))(
    "must be set to '1' here — if this test is running at all (LIVE+CI both true) and the marker is missing, the workflow regressed silently",
    () => {
      // Deliberately not a bare `expect(...).toBe(true)`: this assertion has
      // TWO very different causes, and a plain "expected false to be true"
      // sends the reader down the wrong one. `Boolean(env.CI)` matches any
      // non-empty CI value on purpose — the alternative (pinning `=== "true"`)
      // risks the guard going silently inert if that literal ever changes,
      // and an inert guard is far worse than a noisy one. The cost of that
      // choice is this second cause, so name it here rather than tighten the
      // filter.
      if (!isDisposableHost()) {
        throw new Error(
          `openlock-o4t4: OPENLOCK_DISPOSABLE_HOST is not "1", but this process ` +
            `looks like the live-integration CI job (CI is set and ` +
            `OPENLOCK_LIVE_INTEGRATION="1").\n\n` +
            `IF THIS IS CI: the marker was dropped from the live-integration job's ` +
            `env: in .github/workflows/test.yml. Restore it. Any test gated on ` +
            `isDisposableHost() has been silently skipping since it went missing — ` +
            `that silent skip is exactly what this guard exists to catch.\n\n` +
            `IF THIS IS YOUR OWN MACHINE: your shell exports CI, so this guard ` +
            `mistook a local run for CI. Nothing is broken and nothing unsafe ` +
            `happened — this test asserts a workflow invariant, not a product one. ` +
            `Unset CI for this run. Do NOT set OPENLOCK_DISPOSABLE_HOST=1 to ` +
            `silence it; that would tell every gated test your real state is ` +
            `disposable.`,
        );
      }
      expect(isDisposableHost()).toBe(true);
    },
  );
});
