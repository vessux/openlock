import { describe, expect, it } from "bun:test";
import type { Classification, SessionWithState } from "./reap";
import { buildIdleNudge, type ClassifiedSession, reapIdleStaleSessions } from "./session-ops";

const NOW = new Date("2026-05-07T12:00:00Z").getTime();

function row(
  name: string,
  classification: Classification,
  lastAttachedAt: string | null,
): ClassifiedSession {
  const meta = {
    id: name,
    name,
    repoPath: "/r",
    image: "i",
    policy: "p",
    createdAt: "2026-05-07T08:00:00Z",
    lastAttachedAt,
    attachedPid: null,
    harness: "claude_code" as const,
  };
  const state: SessionWithState = { ...meta, containerState: "running", pidAlive: false };
  return { meta, classification, state };
}

describe("buildIdleNudge", () => {
  it("returns null when no other idle sessions", () => {
    const rows = [row("self", "idle-recent", null)];
    expect(buildIdleNudge(rows, "self", NOW)).toBeNull();
  });

  it("excludes the current session and lists others with idle age", () => {
    const rows = [
      row("self", "idle-recent", null),
      row("alice-47d2b9", "idle-recent", new Date(NOW - 60 * 60 * 1000).toISOString()),
    ];
    const msg = buildIdleNudge(rows, "self", NOW)!;
    expect(msg).toContain("1 other idle sandbox is running");
    expect(msg).toContain("alice-47d2b9");
    expect(msg).toContain("idle 1h");
    expect(msg).not.toContain("self");
    expect(msg).toContain("openlock stop");
  });

  it("pluralizes and includes idle-stale rows", () => {
    const rows = [
      row("a-1", "idle-recent", new Date(NOW - 3 * 60 * 60 * 1000).toISOString()),
      row("b-2", "idle-stale", new Date(NOW - 60 * 60 * 1000).toISOString()),
    ];
    const msg = buildIdleNudge(rows, "self", NOW)!;
    expect(msg).toContain("2 other idle sandboxes are running");
  });

  it("ignores non-idle classifications", () => {
    const rows = [
      row("attached-1", "attached", null),
      row("exited-1", "exited", null),
      row("missing-1", "missing", null),
    ];
    expect(buildIdleNudge(rows, "self", NOW)).toBeNull();
  });
});

describe("reapIdleStaleSessions", () => {
  function stub(name: string): ClassifiedSession {
    return row(name, "idle-stale", new Date(NOW - 60 * 60 * 1000).toISOString());
  }

  it("returns no reaped sessions and calls neither drain nor stop when nothing is idle-stale", async () => {
    const calls: string[] = [];
    const result = await reapIdleStaleSessions({
      classify: async () => [row("self", "idle-recent", null)],
      drain: async () => {
        calls.push("drain");
      },
      stop: async () => {
        calls.push("stop");
      },
    });
    expect(result.reaped).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("drains a session's git work before stopping it (order preserved)", async () => {
    const calls: string[] = [];
    const result = await reapIdleStaleSessions({
      classify: async () => [stub("a")],
      drain: async (containerName, sessionName, hostRepoSource, targetDir) => {
        calls.push(`drain:${containerName}:${sessionName}:${hostRepoSource}:${targetDir}`);
      },
      stop: async (name) => {
        calls.push(`stop:${name}`);
      },
    });
    expect(result.reaped).toEqual(["a"]);
    expect(calls).toEqual(["drain:a:a:/r:/sandbox/repo", "stop:a"]);
  });

  it("still stops the session when drain throws (best-effort drain)", async () => {
    const calls: string[] = [];
    const result = await reapIdleStaleSessions({
      classify: async () => [stub("b")],
      drain: async () => {
        throw new Error("drain boom");
      },
      stop: async (name) => {
        calls.push(`stop:${name}`);
      },
    });
    expect(result.reaped).toEqual(["b"]);
    expect(calls).toEqual(["stop:b"]);
  });

  it("still reports reaped when stop itself throws (stop failures are swallowed, not fatal)", async () => {
    const result = await reapIdleStaleSessions({
      classify: async () => [stub("c")],
      drain: async () => {},
      stop: async () => {
        throw new Error("stop boom");
      },
    });
    expect(result.reaped).toEqual(["c"]);
  });

  it("processes multiple idle-stale sessions independently", async () => {
    const calls: string[] = [];
    const result = await reapIdleStaleSessions({
      classify: async () => [stub("a"), stub("b")],
      drain: async (_c, sessionName) => {
        calls.push(`drain:${sessionName}`);
      },
      stop: async (name) => {
        calls.push(`stop:${name}`);
      },
    });
    expect(result.reaped.sort()).toEqual(["a", "b"]);
    expect(calls).toContain("drain:a");
    expect(calls).toContain("stop:a");
    expect(calls).toContain("drain:b");
    expect(calls).toContain("stop:b");
  });
});
