import { describe, expect, it } from "bun:test";
import { classifySession, resolveReapIdleMs, type SessionWithState } from "./reap";

const NOW = new Date("2026-05-07T12:00:00Z").getTime();
const THIRTY_MIN = 30 * 60 * 1000;

function meta(o: Partial<SessionWithState> = {}): SessionWithState {
  return {
    id: "id",
    name: "n",
    repoPath: "/r",
    image: "i",
    policy: "p",
    createdAt: "2026-05-07T10:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
    harness: "claude_code",
    containerState: "running",
    pidAlive: false,
    ...o,
  };
}

describe("classifySession", () => {
  it("running + alive pid → 'attached'", () => {
    expect(
      classifySession(
        meta({ containerState: "running", attachedPid: 1, pidAlive: true }),
        NOW,
        THIRTY_MIN,
      ),
    ).toBe("attached");
  });

  it("running + dead pid + recent → 'idle-recent'", () => {
    expect(
      classifySession(
        meta({
          attachedPid: 99999,
          pidAlive: false,
          lastAttachedAt: new Date(NOW - 5 * 60_000).toISOString(),
        }),
        NOW,
        THIRTY_MIN,
      ),
    ).toBe("idle-recent");
  });

  it("running + dead pid + old → 'idle-stale' when a threshold is set", () => {
    expect(
      classifySession(
        meta({
          attachedPid: 99999,
          pidAlive: false,
          lastAttachedAt: new Date(NOW - THIRTY_MIN - 1).toISOString(),
        }),
        NOW,
        THIRTY_MIN,
      ),
    ).toBe("idle-stale");
  });

  it("running + dead pid + old → 'idle-recent' when reaping is off (null)", () => {
    expect(
      classifySession(
        meta({
          attachedPid: 99999,
          pidAlive: false,
          lastAttachedAt: new Date(NOW - THIRTY_MIN - 1).toISOString(),
        }),
        NOW,
        null,
      ),
    ).toBe("idle-recent");
  });

  it("running + null pid + null lastAttachedAt → 'idle-recent'", () => {
    expect(
      classifySession(meta({ attachedPid: null, lastAttachedAt: null }), NOW, THIRTY_MIN),
    ).toBe("idle-recent");
  });

  it("exited container → 'exited'", () => {
    expect(classifySession(meta({ containerState: "exited" }), NOW, THIRTY_MIN)).toBe("exited");
  });

  it("missing container → 'missing'", () => {
    expect(classifySession(meta({ containerState: "missing" }), NOW, THIRTY_MIN)).toBe("missing");
  });
});

describe("resolveReapIdleMs", () => {
  it("defaults to null (off) when env and config unset", () => {
    expect(resolveReapIdleMs({ env: undefined, config: undefined })).toBeNull();
  });
  it("config off → null", () => {
    expect(resolveReapIdleMs({ env: undefined, config: "off" })).toBeNull();
  });
  it("config duration (ms number) is used", () => {
    expect(resolveReapIdleMs({ env: undefined, config: THIRTY_MIN })).toBe(THIRTY_MIN);
  });
  it("env integer ms wins over config", () => {
    expect(resolveReapIdleMs({ env: "60000", config: "off" })).toBe(60000);
  });
  it("env off → null, overriding a config duration", () => {
    expect(resolveReapIdleMs({ env: "off", config: THIRTY_MIN })).toBeNull();
    expect(resolveReapIdleMs({ env: "OFF", config: THIRTY_MIN })).toBeNull();
  });
  it("unrecognized env falls through to config", () => {
    expect(resolveReapIdleMs({ env: "garbage", config: THIRTY_MIN })).toBe(THIRTY_MIN);
  });
});
