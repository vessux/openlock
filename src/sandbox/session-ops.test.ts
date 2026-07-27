import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Classification, SessionWithState } from "./reap";
import {
  buildIdleNudge,
  type ClassifiedSession,
  type CleanDeps,
  cleanSession,
  reapIdleStaleSessions,
} from "./session-ops";
import { type SessionMeta, saveSession, sessionDirById, sessionsDir } from "./session-store";

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

describe("cleanSession gateway self-heal (openlock-kx8)", () => {
  let home: string;
  let originalHome: string | undefined;
  let repoDir: string;
  let meta: SessionMeta;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openlock-clean-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    repoDir = mkdtempSync(join(tmpdir(), "openlock-clean-repo-"));
    meta = {
      id: "sess-1",
      name: "proj-abc123",
      repoPath: repoDir,
      image: "img",
      policy: "pol",
      createdAt: "2026-05-07T08:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
      harness: "claude_code",
    };
    saveSession(sessionsDir(), meta);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  function sessionDirExists(): boolean {
    return existsSync(sessionDirById(sessionsDir(), meta.id));
  }

  it("container-exists + gateway-down: self-heals (starts the gateway) before delete when a runtime is configured", async () => {
    const calls: string[] = [];
    const deps: CleanDeps = {
      resolveRuntime: async () => {
        calls.push("resolveRuntime");
        return "podman";
      },
      startGateway: async () => {
        calls.push("startGateway");
      },
      deleteSandbox: async (name) => {
        calls.push(`deleteSandbox:${name}`);
      },
    };
    await cleanSession(meta.name, {}, deps);
    expect(calls).toEqual(["resolveRuntime", "startGateway", `deleteSandbox:${meta.name}`]);
    // Bring-up succeeded, so teardown completed normally.
    expect(sessionDirExists()).toBe(false);
  });

  it("container-exists + gateway-down: does NOT claim success (and does not remove local state) when bring-up fails", async () => {
    const calls: string[] = [];
    const deps: CleanDeps = {
      resolveRuntime: async () => {
        calls.push("resolveRuntime");
        return "podman";
      },
      startGateway: async () => {
        calls.push("startGateway");
        throw new Error("Gateway did not become ready within 30s.");
      },
      deleteSandbox: async (name) => {
        calls.push(`deleteSandbox:${name}`);
      },
    };
    await expect(cleanSession(meta.name, {}, deps)).rejects.toThrow(/did not become ready/);
    // deleteSandbox must never run once bring-up failed — a container may
    // still exist, so pretending it's gone would strand it silently.
    expect(calls).toEqual(["resolveRuntime", "startGateway"]);
    // Local session state must survive an honest failure, not just a
    // "cleaned" success.
    expect(sessionDirExists()).toBe(true);
  });

  it("local-only-stale path: skips gateway bring-up AND the gateway-mediated delete entirely when no runtime is configured, but still tears down local state", async () => {
    const calls: string[] = [];
    const deps: CleanDeps = {
      resolveRuntime: async () => {
        calls.push("resolveRuntime");
        return null;
      },
      startGateway: async () => {
        calls.push("startGateway");
      },
      deleteSandbox: async (name) => {
        calls.push(`deleteSandbox:${name}`);
      },
    };
    await cleanSession(meta.name, {}, deps);
    // Neither startGateway NOR deleteSandbox may run on a box with no
    // resolvable runtime: startGateway could otherwise block on the
    // interactive runtime picker, and deleteSandbox can never succeed
    // without a runtime to back a gateway (it would just throw the same
    // transport error) — so local bookkeeping is removed directly instead.
    // This is narrowly scoped to "no runtime exists at all" (categorically
    // no possible container), NOT a general "gateway unreachable -> assume
    // gone" fallback (that was rejected — see the other two tests, where a
    // runtime IS configured and a failed bring-up leaves local state
    // intact).
    expect(calls).toEqual(["resolveRuntime"]);
    expect(sessionDirExists()).toBe(false);
  });
});
