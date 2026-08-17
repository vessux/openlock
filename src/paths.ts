import { homedir } from "node:os";
import { join } from "node:path";

export function forkDir(): string {
  return join(import.meta.dir, "..", "openshell-fork");
}

/** The state dir absent any override: HOME-relative, no XDG_STATE_HOME
 * support. See `resolveStateDir`'s doc for why XDG_STATE_HOME is
 * deliberately not honored. */
export function defaultStateDir(): string {
  return join(process.env.HOME || homedir(), ".local", "state", "openlock");
}

/**
 * Single resolver for openlock's per-user state dir (openlock-x8m8:
 * `~/.local/state/openlock` by default — gateway pid/log/config/db, the
 * sandbox-JWT signing bundle, and session metadata all live under it).
 *
 * EVERY read site across the codebase (gateway state in
 * `sandbox/ensure-gateway.ts`, session metadata in
 * `sandbox/session-store.ts`, `openlock report`'s bundle in
 * `cli/report.ts`) must route through this one function. Before this existed,
 * `ensure-gateway.ts` and `report.ts` each independently recomputed the same
 * HOME-relative path inline, and `session-store.ts` did too — the exact
 * "split-surface" bug shape this project keeps hitting: an override added to
 * one call site silently does nothing on the others.
 *
 * Precedence: `explicit` (a caller-supplied override — e.g. `report.ts`'s own
 * `ReportOptions.stateDir`, which its tests use to point at a scratch dir
 * without touching real state) > `OPENLOCK_STATE_DIR` (the documented,
 * explicit env override, read at CALL time so it works for any caller,
 * including a test harness that sets it before spawning a child process) >
 * the HOME-relative default.
 *
 * Deliberately does NOT read `XDG_STATE_HOME`, even though
 * `~/.local/state/openlock` looks XDG-shaped: honoring it now would SILENTLY
 * relocate every existing install for anyone who already exports
 * `XDG_STATE_HOME` (common on minimal/systemd-managed Linux setups) — moving
 * their gateway port (see `ensure-gateway.ts`'s `resolveGatewayPort`, which
 * derives the port from this path) and orphaning their already-running
 * gateway. `OPENLOCK_STATE_DIR` is opt-in and explicitly named; nothing sets
 * it by accident.
 */
export function resolveStateDir(explicit?: string): string {
  return explicit ?? process.env.OPENLOCK_STATE_DIR ?? defaultStateDir();
}

// Set true the first time an active OPENLOCK_CONFIG_DIR override produces
// the loud stderr notice below — module-scoped so the notice fires ONCE per
// process, not once per resolveConfigDir() call (credentialsPath() and
// globalConfigPath() are both called many times per run). Test-only reset
// below; production code never touches this directly.
let warnedConfigDirOverride = false;

/** Test-only: clear the "already warned" latch so a test can assert the
 * notice fires exactly once without depending on suite/file run order.
 * Never called by production code. */
export function _resetConfigDirWarningForTests(): void {
  warnedConfigDirOverride = false;
}

function warnConfigDirOverrideOnce(dir: string): void {
  if (warnedConfigDirOverride) return;
  warnedConfigDirOverride = true;
  // stderr, deliberately never stdout: several tests (e.g.
  // src/cli/validate.output.test.ts) assert stdout byte-for-byte, and this
  // notice must never be able to corrupt machine-readable stdout output.
  console.error(
    `openlock: OPENLOCK_CONFIG_DIR is set — using ${dir} for credentials and global config ` +
      `instead of the default. This is a test-only override.`,
  );
}

/**
 * Single resolver for openlock's own config directory (holds
 * `credentials.json` and `config.yaml` — see `../tokens.ts`'s
 * `credentialsPath` and `../global-config/paths.ts`'s `globalConfigPath`,
 * both of which must route through this function rather than recomputing
 * the same `XDG_CONFIG_HOME`/`$HOME/.config` resolution inline, exactly the
 * split-surface bug shape `resolveStateDir`'s doc above already warns
 * about).
 *
 * Precedence: `OPENLOCK_CONFIG_DIR` (set and non-empty) > `XDG_CONFIG_HOME`
 * > `$HOME/.config`, then `/openlock` appended — EXCEPT when
 * `OPENLOCK_CONFIG_DIR` wins, in which case it IS the config dir and is
 * used AS-IS, with no `openlock` suffix appended (the caller already named
 * the directory openlock should use).
 *
 * WHY THIS VAR AND NOT `XDG_CONFIG_HOME` (openlock-6pwu — do not
 * "simplify" this back, a prior attempt already hit this dead end):
 * `XDG_CONFIG_HOME` is honoured by podman for its OWN config, and a
 * compiled openlock binary spawned as a child inherits whatever env the
 * parent set — so pointing a test at synthetic state via `XDG_CONFIG_HOME`
 * also silently breaks podman itself (measured directly on macOS:
 * `XDG_CONFIG_HOME=<fake> podman machine list` returns an EMPTY table with
 * a real machine still running). `OPENLOCK_CONFIG_DIR` is openlock-only;
 * podman never reads it, so it can isolate credentials.json/config.yaml
 * without perturbing the runtime the sandbox actually depends on.
 *
 * This is a TEST SEAM, not a supported production configuration surface —
 * deliberately undocumented in docs/ (same treatment as
 * `OPENLOCK_OPENSHELL_BIN`/`OPENLOCK_REBUILD` in `sandbox/fork-binaries.ts`).
 * Because a silent redirect here would look exactly like `openlock login`
 * doing nothing (credentials.json appears not to change because a
 * *different* file is being read/written entirely — the same
 * never-clobber-looks-like-a-no-op confusion this project already hit once,
 * see project_gateway_cred_replacement_2026_07_31), an active override
 * prints a loud one-time stderr notice rather than silently taking effect.
 * Silence here is the failure mode this guards against — a user who sets
 * this by accident must find out immediately, not after concluding `login`
 * is broken.
 *
 * SCOPE — THIS IS PARTIAL ISOLATION, AND THE GAP IS THE DANGEROUS PART.
 * This covers ONLY `credentials.json` and `config.yaml`. It does NOT
 * isolate the openshell gateway registry (`ensure-gateway.ts` resolves
 * that from `XDG_CONFIG_HOME` under the fixed name `podman-dev`), gateway
 * provider records (openlock only reaches those by spawning the real
 * `openshell` CLI), or the state dir (that has its own seam,
 * `OPENLOCK_STATE_DIR`, via `resolveStateDir` above). So setting this var
 * alone does NOT make a test safe against the real dev gateway — and
 * gateway provider VALUES cannot be read back at all (`provider list`
 * prints only names/keys), so anything overwritten there is
 * unrecoverable, with no backup/restore option, only refuse-to-run.
 * Isolating gateway state needs a genuinely separate scratch gateway —
 * tracked as openlock-kjm7. Do not mistake this seam for full isolation.
 */
export function resolveConfigDir(): string {
  const override = process.env.OPENLOCK_CONFIG_DIR;
  if (override !== undefined && override.length > 0) {
    warnConfigDirOverrideOnce(override);
    return override;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(process.env.HOME ?? homedir(), ".config");
  return join(base, "openlock");
}
