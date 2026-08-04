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
