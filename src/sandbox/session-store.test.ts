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
      path: "/tmp/project",
      caps: ["js"],
      image: "openlock-core-js:abc123def456",
      policy: "policies/default-js.yaml",
      createdAt: "2026-05-03T12:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
    };
    saveSession(testDir, meta);
    const loaded = loadSession(testDir, "existing-test-1");
    expect(loaded).toEqual(meta);
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
      path: "/tmp/repo",
      caps: [],
      image: "openlock-core:abc123",
      policy: "/abs/policy.yaml",
      createdAt: "2026-05-07T10:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
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

  it("findSessionsByPath filters by canonical path", () => {
    saveSession(base, fixture({ id: "a", path: "/repo/x" }));
    saveSession(base, fixture({ id: "b", path: "/repo/y" }));
    saveSession(base, fixture({ id: "c", path: "/repo/x" }));
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
