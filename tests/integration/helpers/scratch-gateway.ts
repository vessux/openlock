// Reusable scratch-gateway isolation helper, extracted from
// tests/integration/gateway-foreign-refusal.test.ts (bd openlock-kjm7).
//
// ============================================================================
// PLATFORM APPLICABILITY — READ BEFORE CALLING ANYTHING IN THIS FILE
// ============================================================================
// CI / LINUX-ROOTLESS PODMAN ONLY. UNVERIFIED, AND PLAUSIBLY UNSAFE, ON
// macOS. Do not assume otherwise because the live-integration job is green —
// that job runs on Linux rootless podman, which has no `machine` layer at
// all, so a green run there is NOT evidence this is safe on a Mac.
//
// The mechanism below overrides `XDG_CONFIG_HOME` around a real
// `startGateway()` / real podman-spawning call. `XDG_CONFIG_HOME` is not an
// openlock-specific seam: podman itself honours it for its OWN config, and a
// process this suite spawns as a child inherits whatever `XDG_CONFIG_HOME`
// the parent set. On macOS this is measured to break podman's own tooling —
// `XDG_CONFIG_HOME=<scratch> podman machine list` returns an EMPTY table
// even with a real machine running (see src/paths.ts's `resolveConfigDir`
// doc comment and the openlock-6pwu/openlock-kjm7 history for the full
// writeup). Linux rootless podman has no `machine` layer, so nothing
// analogous has ever been observed to break there — but "nothing observed"
// on the one platform this has ever run on is not the same as "verified
// safe" on the platform it has never run on.
//
// Do NOT call any function in this file outside a test that has already
// called `requireDisposableHost()` (tests/integration/helpers/disposable-
// host.ts) and is gated behind `OPENLOCK_LIVE_INTEGRATION=1`. Today that
// means: CI's `live-integration` job only. There is deliberately no local
// disposable-host equivalent yet (tracked as bd openlock-uze8) — until that
// exists, this helper has no environment on which it is safe to run by
// hand, including this repo's own dev Mac.
// ============================================================================
//
// WHAT THIS SOLVES: relocating `OPENLOCK_STATE_DIR` alone is NOT sufficient
// isolation for a gateway-spawning test. `registerGatewayMetadata`
// (src/sandbox/ensure-gateway.ts) writes the SHARED openshell gateway
// registry at `<XDG_CONFIG_HOME>/openshell/gateways/<GATEWAY_NAME>/
// metadata.json` — a path keyed by `XDG_CONFIG_HOME` (defaulting to
// `~/.config`, NOT under the openlock state dir at all) and by the FIXED
// constant `GATEWAY_NAME` ("podman-dev"). A test that relocates only
// `OPENLOCK_STATE_DIR` still writes that one real, shared file, repointing
// a developer's (or CI's) real gateway registry at a scratch endpoint that
// dies with the test. `XDG_CONFIG_HOME` must be overridden to a scratch
// directory everywhere `OPENLOCK_STATE_DIR` is.
//
// Two pieces:
//   1. `withScratchGatewayEnv` / `scratchGatewayChildEnv` — the dual
//      OPENLOCK_STATE_DIR + XDG_CONFIG_HOME override, for an in-process call
//      and a spawned child respectively. Deliberately does NOT touch
//      OPENLOCK_RUNTIME (driver selection is a separate concern from state
//      isolation; callers manage it themselves).
//   2. `captureRealGatewayRegistry` / `assertRealGatewayRegistryUnchanged` —
//      the assertion oracle that converts "we hope this is isolated" into a
//      hard, loud failure the moment it stops being true. Must be captured
//      BEFORE any override in this file is applied.
//
// The oracle's path derivation is DELIBERATELY DUPLICATED from
// `registerGatewayMetadata`'s (unexported) resolution in ensure-gateway.ts,
// not imported from it — a bug in the production resolver must not be able
// to fool the very oracle that exists to catch it. `GATEWAY_NAME` is
// imported (not re-literaled) so this can't drift on a rename; keep the rest
// of this derivation in sync by hand if ensure-gateway.ts's resolution ever
// changes.

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAY_NAME } from "../../../src/sandbox/ensure-gateway";

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * The REAL, shared openshell gateway registry file's path. See this file's
 * header for why this is duplicated rather than imported from
 * ensure-gateway.ts. Must be called before any `XDG_CONFIG_HOME` override in
 * this file is applied, or it resolves the scratch path instead of the real
 * one.
 */
export function realGatewayRegistryMetadataPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME || homedir(), ".config");
  return join(configHome, "openshell", "gateways", GATEWAY_NAME, "metadata.json");
}

export interface RealGatewayRegistrySnapshot {
  readonly path: string;
  readonly contentsBefore: string | null;
}

/**
 * Captures the real, shared gateway registry's current contents (or `null`
 * if it doesn't exist). Call this FIRST, before any scratch override below —
 * that is the only way it resolves the real path rather than a scratch one.
 */
export function captureRealGatewayRegistry(): RealGatewayRegistrySnapshot {
  const path = realGatewayRegistryMetadataPath();
  return { path, contentsBefore: readFileOrNull(path) };
}

/**
 * Asserts the real, shared gateway registry is byte-identical to what
 * `captureRealGatewayRegistry` observed — unchanged if it existed, still
 * absent if it didn't. Call this in a `finally` block so it still runs (and
 * still fails loudly) even when an earlier assertion in the same test
 * already failed — the whole point of this oracle is to catch isolation
 * regressions that a test's own primary assertions would never notice.
 */
export function assertRealGatewayRegistryUnchanged(snapshot: RealGatewayRegistrySnapshot): void {
  expect(readFileOrNull(snapshot.path)).toBe(snapshot.contentsBefore);
}

/** The env vars a spawned CHILD process needs to use a scratch gateway
 * instead of the real, shared one. Does NOT include `OPENLOCK_RUNTIME` —
 * driver selection is the caller's concern, not this helper's. */
export function scratchGatewayChildEnv(
  stateDir: string,
  xdgConfigHome: string,
): { OPENLOCK_STATE_DIR: string; XDG_CONFIG_HOME: string } {
  return { OPENLOCK_STATE_DIR: stateDir, XDG_CONFIG_HOME: xdgConfigHome };
}

/**
 * Runs `fn` with `OPENLOCK_STATE_DIR` and `XDG_CONFIG_HOME` overridden to
 * scratch values, IN-PROCESS — for direct calls to exported functions like
 * `startGateway()` (never for the CLI's own gateway-start path, which calls
 * `process.exit()` on its failure branches; use a spawned child plus
 * `scratchGatewayChildEnv` for that). Restores both vars to their prior
 * values (including "was unset") once `fn` settles, whether it resolved or
 * threw. Does NOT save/restore `OPENLOCK_RUNTIME` — callers that need a
 * specific driver must save/restore it themselves around this call.
 */
export async function withScratchGatewayEnv<T>(
  stateDir: string,
  xdgConfigHome: string,
  fn: () => Promise<T>,
): Promise<T> {
  const savedStateDir = process.env.OPENLOCK_STATE_DIR;
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.OPENLOCK_STATE_DIR = stateDir;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  try {
    return await fn();
  } finally {
    if (savedStateDir === undefined) delete process.env.OPENLOCK_STATE_DIR;
    else process.env.OPENLOCK_STATE_DIR = savedStateDir;
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
  }
}
