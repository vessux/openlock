import { readGlobalConfig } from "../global-config";
import type { ContainerState } from "./container";
import type { SessionMeta } from "./session-store";

/** Resolve the idle window in ms, or null when reaping is off.
 * Precedence: OPENLOCK_REAP_IDLE_MS env (integer ms, or "off") >
 * reap_idle config > default (off). Pure — inputs injected for testability. */
export function resolveReapIdleMs(opts: {
  env: string | undefined;
  config: number | "off" | undefined;
}): number | null {
  const env = opts.env?.trim();
  if (env !== undefined && env !== "") {
    if (/^\d+$/.test(env)) return parseInt(env, 10);
    if (env.toLowerCase() === "off") return null;
    // unrecognized env value: ignore, fall through to config
  }
  if (opts.config !== undefined) {
    return opts.config === "off" ? null : opts.config;
  }
  return null; // default: off
}

function readReapIdleConfig(): number | "off" | undefined {
  try {
    return readGlobalConfig()?.reapIdle;
  } catch {
    return undefined;
  }
}

/** Resolved idle window in ms from the real env + global config. null = off. */
export function reapIdleMs(): number | null {
  return resolveReapIdleMs({
    env: process.env.OPENLOCK_REAP_IDLE_MS,
    config: readReapIdleConfig(),
  });
}

/** Interval for the lastAttachedAt heartbeat while a harness is attached:
 * half the idle window, capped at 60s so a huge idle window doesn't write to
 * disk too infrequently, floored at 1s so a tiny idle window doesn't produce
 * a 0/absurd interval. Pure — caller decides whether to run it at all
 * (only when reaping is on, i.e. idleMs !== null). */
export function heartbeatIntervalMs(idleMs: number): number {
  return Math.max(1000, Math.min(Math.floor(idleMs / 2), 60_000));
}

export type Classification = "attached" | "idle-recent" | "idle-stale" | "exited" | "missing";

export interface SessionWithState extends SessionMeta {
  containerState: ContainerState;
  pidAlive: boolean;
}

/** Classify a session. `idleMs` is the resolved reap window (null = off);
 * a session is only ever "idle-stale" (reap-eligible) when a window is set. */
export function classifySession(
  s: SessionWithState,
  nowMs: number,
  idleMs: number | null,
): Classification {
  if (s.containerState === "missing") return "missing";
  if (s.containerState !== "running") return "exited";
  if (s.attachedPid !== null && s.pidAlive) return "attached";
  if (idleMs === null) return "idle-recent";
  const last = s.lastAttachedAt ? new Date(s.lastAttachedAt).getTime() : null;
  if (last === null) return "idle-recent";
  if (nowMs - last > idleMs) return "idle-stale";
  return "idle-recent";
}
