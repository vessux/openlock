// Fail-closed "disposable host" marker (bd openlock-o4t4).
//
// A host sets OPENLOCK_DISPOSABLE_HOST=1 to assert: "my state is
// disposable — a test may mutate real-state paths here (credentials, a
// gateway registry, podman/docker storage) because nothing on me needs to
// survive." This is the CI-side half of the escape hatch for the
// tests-use-synthetic-state-only policy (feedback_tests_synthetic_state_
// only): when a test genuinely cannot run against synthetic state (it
// needs the real compiled binary, real podman, a real gateway), it may run
// destructively — but ONLY on a host that has said so explicitly. Absence
// of the marker must refuse the test, never fall back to a "careful"
// backup/restore of real state — a prior incident already showed that
// shape corrupts real credentials.json.
//
// Set today by the `live-integration` job in .github/workflows/test.yml —
// see that job's own `env:` comment for why that specific runner
// qualifies (throwaway ubuntu-24.04, fresh HOME, real podman, nothing of
// an operator's on it). The local-machine equivalent (a disposable VM a
// developer can run this against on their own laptop) is a SEPARATE,
// not-yet-built piece — bd openlock-uze8 — so today this marker is only
// ever "1" in CI.
//
// LIVES UNDER tests/, NOT src/: this is test infrastructure and must never
// become part of the shipped product surface. That placement has one
// consequence worth stating explicitly: knip's `project` scope is
// `src/**/*.ts` (see knip.json / package.json config), so knip cannot see
// this file or its exports at all — it will NOT flag `requireDisposableHost`
// as an unused export if every caller of it is later deleted. There is no
// automated backstop for that here; keeping this module wired to a real
// caller (tests/integration/disposable-host.test.ts's own guard, plus this
// file's unit tests) is a manual obligation, not a tooling guarantee.

const DISPOSABLE_HOST_ENV = "OPENLOCK_DISPOSABLE_HOST";

/** True only when the host has explicitly asserted its state is disposable
 * — i.e. `OPENLOCK_DISPOSABLE_HOST` is exactly the string `"1"`. Anything
 * else (unset, empty, `"true"`, `"0"`, ...) is treated as NOT disposable:
 * this is a fail-CLOSED check, so an unrecognized value must refuse rather
 * than guess. */
export function isDisposableHost(): boolean {
  return process.env[DISPOSABLE_HOST_ENV] === "1";
}

/**
 * Fail-closed guard for a test that is about to do something destructive
 * to REAL host state — real credentials, a real dev gateway, real
 * podman/docker storage — rather than synthetic tmpdir state. Call this at
 * the top of such a test (or its `beforeAll`/`beforeEach`), before anything
 * destructive happens.
 *
 * Throws immediately when the marker is absent — never a silent skip, and
 * never a "back up first, then proceed" fallback (see
 * feedback_tests_synthetic_state_only: "has a backup" was already read as
 * a confirmed-safe signal once and it rm -sync'd real credentials.json).
 * The thrown message is written for someone hitting this on their own
 * laptop, not in CI: it must be immediately obvious that this is
 * PROTECTING their real state, not a broken test, and that setting the
 * variable themselves to silence it would be the opposite of safe.
 *
 * `what` names the specific action being attempted (e.g. "sandbox create
 * against the real dev gateway"), so the error is actionable rather than
 * generic.
 */
export function requireDisposableHost(what: string): void {
  if (isDisposableHost()) return;
  throw new Error(
    `openlock-o4t4: refusing to run "${what}" — it mutates REAL host state ` +
      `(credentials, a real dev gateway, or real podman/docker storage), and ` +
      `${DISPOSABLE_HOST_ENV} is not set to "1" on this host.\n\n` +
      `This is NOT a broken test. It is protecting YOUR real credentials and ` +
      `gateway state from a test that cannot safely run against synthetic ` +
      `state. Do NOT set ${DISPOSABLE_HOST_ENV}=1 on your own machine to make ` +
      `this error go away — that tells this test your local state is ` +
      `disposable, and it is not; there is no undo for what this test would ` +
      `do to it.\n\n` +
      `${DISPOSABLE_HOST_ENV}=1 is set by the live-integration CI job ` +
      `(.github/workflows/test.yml), because that runner genuinely is a ` +
      `disposable host: a throwaway VM, a fresh HOME, real podman, and ` +
      `nothing of an operator's on it. If you need to run this test on your ` +
      `own machine, use a genuinely disposable environment instead (the ` +
      `local disposable-host runner tracked as bd openlock-uze8) — never ` +
      `this variable against a real one.`,
  );
}
