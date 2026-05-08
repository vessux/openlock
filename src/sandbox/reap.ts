import type { ContainerState } from "./container";
import type { SessionMeta } from "./session-store";

export const REAP_IDLE_MS_DEFAULT = 30 * 60 * 1000;

function reapIdleMs(): number {
  const v = process.env.OPENLOCK_REAP_IDLE_MS;
  if (v && /^\d+$/.test(v)) return parseInt(v, 10);
  return REAP_IDLE_MS_DEFAULT;
}

export type Classification = "attached" | "idle-recent" | "idle-stale" | "exited" | "missing";

export interface SessionWithState extends SessionMeta {
  containerState: ContainerState;
  pidAlive: boolean;
}

export function classifySession(s: SessionWithState, nowMs: number): Classification {
  if (s.containerState === "missing") return "missing";
  if (s.containerState !== "running") return "exited";
  if (s.attachedPid !== null && s.pidAlive) return "attached";
  const last = s.lastAttachedAt ? new Date(s.lastAttachedAt).getTime() : null;
  if (last === null) return "idle-recent";
  if (nowMs - last > reapIdleMs()) return "idle-stale";
  return "idle-recent";
}
