import { describe, expect, it } from "bun:test";
import { classifySession, REAP_IDLE_MS_DEFAULT, type SessionWithState } from "./reap";

const NOW = new Date("2026-05-07T12:00:00Z").getTime();

function meta(o: Partial<SessionWithState> = {}): SessionWithState {
  return {
    id: "id",
    name: "n",
    path: "/r",
    caps: [],
    image: "i",
    policy: "p",
    createdAt: "2026-05-07T10:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
    containerState: "running",
    pidAlive: false,
    ...o,
  };
}

describe("classifySession", () => {
  it("running + alive pid → 'attached'", () => {
    expect(
      classifySession(meta({ containerState: "running", attachedPid: 1, pidAlive: true }), NOW),
    ).toBe("attached");
  });

  it("running + dead pid + recent → 'idle-recent'", () => {
    expect(
      classifySession(
        meta({
          containerState: "running",
          attachedPid: 99999,
          pidAlive: false,
          lastAttachedAt: new Date(NOW - 5 * 60_000).toISOString(),
        }),
        NOW,
      ),
    ).toBe("idle-recent");
  });

  it("running + dead pid + old → 'idle-stale' (reap candidate)", () => {
    expect(
      classifySession(
        meta({
          containerState: "running",
          attachedPid: 99999,
          pidAlive: false,
          lastAttachedAt: new Date(NOW - REAP_IDLE_MS_DEFAULT - 1).toISOString(),
        }),
        NOW,
      ),
    ).toBe("idle-stale");
  });

  it("running + null pid + null lastAttachedAt → 'idle-recent'", () => {
    expect(
      classifySession(
        meta({ containerState: "running", attachedPid: null, lastAttachedAt: null }),
        NOW,
      ),
    ).toBe("idle-recent");
  });

  it("exited container → 'exited'", () => {
    expect(classifySession(meta({ containerState: "exited" }), NOW)).toBe("exited");
  });

  it("missing container → 'missing'", () => {
    expect(classifySession(meta({ containerState: "missing" }), NOW)).toBe("missing");
  });
});
