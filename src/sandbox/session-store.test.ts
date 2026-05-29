import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSession, type SessionMeta, saveSession } from "./session-store";

const testDir = join(import.meta.dir, "../../.test-sessions");

describe("session-store", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves and loads session metadata", () => {
    const meta: SessionMeta = {
      id: "existing-test-1",
      name: "test-session",
      repoPath: "/tmp/project",
      image: "openlock-sandbox:abc123def456",
      policy: "policies/default.yaml",
      createdAt: "2026-05-03T12:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
      harness: "claude_code",
    };
    saveSession(testDir, meta);
    const loaded = loadSession(testDir, "existing-test-1");
    expect(loaded).toEqual(meta);
  });

  it("loads legacy session meta with caps field (silently drops it)", () => {
    const id = "legacy-with-caps";
    mkdirSync(join(testDir, id), { recursive: true });
    writeFileSync(
      join(testDir, id, "meta.json"),
      JSON.stringify({
        id,
        name: "legacy-caps",
        repoPath: "/tmp/old",
        caps: ["js", "py"],
        image: "openlock-core-js-py:abc",
        policy: "policies/default-js-py.yaml",
        createdAt: "2026-05-03T12:00:00Z",
        lastAttachedAt: null,
        attachedPid: null,
        harness: "claude_code",
      }),
    );
    const loaded = loadSession(testDir, id);
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as { caps?: unknown }).caps).toBeUndefined();
    expect(loaded?.repoPath).toBe("/tmp/old");
  });

  it("returns null for non-existent session", () => {
    expect(loadSession(testDir, "nope")).toBeNull();
  });
});

import {
  findSessionsByPath,
  listAllSessions,
  removeSessionDir,
  sessionDirById,
  updateSessionMeta,
} from "./session-store";

describe("session-store v2", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "openlock-store-"));
  });

  function fixture(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return {
      id: "0190a2d5-7c6a-7b3e-8f4d-abcdef123456",
      name: "openlock-123456",
      repoPath: "/tmp/repo",
      image: "openlock-sandbox:abc123",
      policy: "/abs/policy.yaml",
      createdAt: "2026-05-07T10:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
      harness: "claude_code",
      ...overrides,
    };
  }

  it("listAllSessions returns empty array on empty dir", () => {
    expect(listAllSessions(base)).toEqual([]);
  });

  it("listAllSessions returns metas keyed by id-dir", () => {
    saveSession(base, fixture({ id: "a", name: "n-a" }));
    saveSession(base, fixture({ id: "b", name: "n-b" }));
    const all = listAllSessions(base)
      .map((m) => m.id)
      .sort();
    expect(all).toEqual(["a", "b"]);
  });

  it("listAllSessions skips dirs without meta.json", () => {
    mkdirSync(join(base, "stray"));
    expect(listAllSessions(base)).toEqual([]);
  });

  it("listAllSessions skips dirs with malformed meta.json", () => {
    mkdirSync(join(base, "bad"));
    writeFileSync(join(base, "bad", "meta.json"), "{not json");
    expect(listAllSessions(base)).toEqual([]);
  });

  it("loadSession migrates legacy `path` field to `repoPath`", () => {
    const id = "legacy-1";
    mkdirSync(join(base, id));
    const legacy = {
      id,
      name: "n-legacy",
      path: "/repo/legacy",
      image: "img",
      policy: "/p",
      createdAt: "2026-05-07T10:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
    };
    writeFileSync(join(base, id, "meta.json"), JSON.stringify(legacy));
    const loaded = loadSession(base, id);
    expect(loaded?.repoPath).toBe("/repo/legacy");
    expect((loaded as unknown as { path?: string }).path).toBeUndefined();
  });

  it("findSessionsByPath filters by canonical path", () => {
    saveSession(base, fixture({ id: "a", repoPath: "/repo/x" }));
    saveSession(base, fixture({ id: "b", repoPath: "/repo/y" }));
    saveSession(base, fixture({ id: "c", repoPath: "/repo/x" }));
    const ids = findSessionsByPath(base, "/repo/x")
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(["a", "c"]);
  });

  it("sessionDirById returns the per-session dir", () => {
    expect(sessionDirById("/state", "abc")).toBe("/state/abc");
  });

  it("removeSessionDir is idempotent on missing dir", () => {
    expect(() => removeSessionDir(base, "missing")).not.toThrow();
  });

  it("removeSessionDir deletes a real dir", () => {
    saveSession(base, fixture({ id: "z" }));
    removeSessionDir(base, "z");
    expect(listAllSessions(base)).toEqual([]);
  });

  it("updateSessionMeta merges fields and persists", () => {
    saveSession(base, fixture({ id: "u", attachedPid: null }));
    updateSessionMeta(base, "u", { attachedPid: 4242, lastAttachedAt: "2026-05-07T11:00:00Z" });
    const [meta] = listAllSessions(base);
    expect(meta!.attachedPid).toBe(4242);
    expect(meta!.lastAttachedAt).toBe("2026-05-07T11:00:00Z");
  });
});

describe("session-store harness field (backward compat)", () => {
  let baseDir: string;

  function setup(): string {
    baseDir = mkdtempSync(join(tmpdir(), "openlock-session-harness-"));
    return baseDir;
  }

  function cleanup(): void {
    rmSync(baseDir, { recursive: true, force: true });
  }

  it("legacy record without harness field reads as claude_code", () => {
    setup();
    try {
      const id = "test-id-legacy";
      const dir = join(baseDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "meta.json"),
        JSON.stringify({
          id,
          name: "sb-legacy",
          repoPath: "/some/repo",
          image: "openlock-core",
          policy: "default",
          createdAt: "2026-05-01T00:00:00Z",
          lastAttachedAt: null,
          attachedPid: null,
        }),
      );
      const meta = loadSession(baseDir, id);
      expect(meta).not.toBeNull();
      expect(meta?.harness).toBe("claude_code");
    } finally {
      cleanup();
    }
  });

  it("new record with explicit harness is persisted and reads back", () => {
    setup();
    try {
      const meta: SessionMeta = {
        id: "test-id-new",
        name: "sb-new",
        repoPath: "/some/repo",
        image: "openlock-core",
        policy: "default",
        createdAt: "2026-05-19T00:00:00Z",
        lastAttachedAt: null,
        attachedPid: null,
        harness: "opencode",
      };
      saveSession(baseDir, meta);
      const loaded = loadSession(baseDir, meta.id);
      expect(loaded?.harness).toBe("opencode");
    } finally {
      cleanup();
    }
  });
});
