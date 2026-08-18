import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStateDir } from "../paths";
import { loadSession, type SessionMeta, saveSession, sessionsDir } from "./session-store";

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

describe("session-store attachedCredentialBundles field (openlock-04t)", () => {
  let baseDir: string;

  function setup(): string {
    baseDir = mkdtempSync(join(tmpdir(), "openlock-session-credbundles-"));
    return baseDir;
  }

  function cleanup(): void {
    rmSync(baseDir, { recursive: true, force: true });
  }

  it("round-trips a present-and-empty array (genuinely nothing attached at create)", () => {
    setup();
    try {
      const meta: SessionMeta = {
        id: "test-id-empty-bundles",
        name: "sb-empty-bundles",
        repoPath: "/some/repo",
        image: "openlock-core",
        policy: "default",
        createdAt: "2026-07-28T00:00:00Z",
        lastAttachedAt: null,
        attachedPid: null,
        harness: "claude_code",
        attachedCredentialBundles: [],
      };
      saveSession(baseDir, meta);
      const loaded = loadSession(baseDir, meta.id);
      expect(loaded?.attachedCredentialBundles).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("round-trips a non-empty recorded set", () => {
    setup();
    try {
      const meta: SessionMeta = {
        id: "test-id-with-bundles",
        name: "sb-with-bundles",
        repoPath: "/some/repo",
        image: "openlock-core",
        policy: "default",
        createdAt: "2026-07-28T00:00:00Z",
        lastAttachedAt: null,
        attachedPid: null,
        harness: "claude_code",
        attachedCredentialBundles: ["github", "npm"],
      };
      saveSession(baseDir, meta);
      const loaded = loadSession(baseDir, meta.id);
      expect(loaded?.attachedCredentialBundles).toEqual(["github", "npm"]);
    } finally {
      cleanup();
    }
  });

  // The migration-safety case (openlock-04t): a session written to disk
  // before this field existed must read back with the field UNDEFINED, not
  // silently coerced to `[]` — undefined is what tells reattach's drift
  // check "unknown, can't compare, don't warn", whereas `[]` would be read
  // as "genuinely nothing was ever attached" and flag every declared bundle
  // as unattached on the very first reattach after this feature ships.
  it("legacy record with the field entirely absent reads back as undefined, NOT []", () => {
    setup();
    try {
      const id = "legacy-no-bundles-field";
      mkdirSync(join(baseDir, id), { recursive: true });
      writeFileSync(
        join(baseDir, id, "meta.json"),
        JSON.stringify({
          id,
          name: "sb-legacy-credbundles",
          repoPath: "/some/repo",
          image: "openlock-core",
          policy: "default",
          createdAt: "2026-05-01T00:00:00Z",
          lastAttachedAt: null,
          attachedPid: null,
          harness: "claude_code",
          // no attachedCredentialBundles key at all — pre-dates this feature.
        }),
      );
      const loaded = loadSession(baseDir, id);
      expect(loaded).not.toBeNull();
      expect(loaded?.attachedCredentialBundles).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("session-store debugEgress/branch fields (openlock-tgfk)", () => {
  let baseDir: string;

  function setup(): string {
    baseDir = mkdtempSync(join(tmpdir(), "openlock-session-tgfk-"));
    return baseDir;
  }

  function cleanup(): void {
    rmSync(baseDir, { recursive: true, force: true });
  }

  it("round-trips debugEgress: false (a real, comparable measurement — not absence)", () => {
    setup();
    try {
      const meta: SessionMeta = {
        id: "test-id-debug-false",
        name: "sb-debug-false",
        repoPath: "/some/repo",
        image: "openlock-core",
        policy: "default",
        createdAt: "2026-08-18T00:00:00Z",
        lastAttachedAt: null,
        attachedPid: null,
        harness: "claude_code",
        debugEgress: false,
        branch: null,
      };
      saveSession(baseDir, meta);
      const loaded = loadSession(baseDir, meta.id);
      expect(loaded?.debugEgress).toBe(false);
      expect(loaded?.branch).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("round-trips debugEgress: true and a recorded branch string", () => {
    setup();
    try {
      const meta: SessionMeta = {
        id: "test-id-debug-true",
        name: "sb-debug-true",
        repoPath: "/some/repo",
        image: "openlock-core",
        policy: "default",
        createdAt: "2026-08-18T00:00:00Z",
        lastAttachedAt: null,
        attachedPid: null,
        harness: "claude_code",
        debugEgress: true,
        branch: "feature/x",
      };
      saveSession(baseDir, meta);
      const loaded = loadSession(baseDir, meta.id);
      expect(loaded?.debugEgress).toBe(true);
      expect(loaded?.branch).toBe("feature/x");
    } finally {
      cleanup();
    }
  });

  // Migration-safety case, same shape as attachedCredentialBundles's: a
  // session written before these fields existed must read back as
  // `undefined` — the "unknown, can't compare" signal the drift warnings key
  // on — NOT silently coerced to `false`/`null`, which would read as a real,
  // comparable measurement (SessionMeta.debugEgress's doc comment: absent !=
  // false; SessionMeta.branch's doc comment: absent != null).
  it("legacy record with both fields entirely absent reads back as undefined, NOT false/null", () => {
    setup();
    try {
      const id = "legacy-no-tgfk-fields";
      mkdirSync(join(baseDir, id), { recursive: true });
      writeFileSync(
        join(baseDir, id, "meta.json"),
        JSON.stringify({
          id,
          name: "sb-legacy-tgfk",
          repoPath: "/some/repo",
          image: "openlock-core",
          policy: "default",
          createdAt: "2026-05-01T00:00:00Z",
          lastAttachedAt: null,
          attachedPid: null,
          harness: "claude_code",
          // no debugEgress/branch keys at all — pre-dates openlock-tgfk.
        }),
      );
      const loaded = loadSession(baseDir, id);
      expect(loaded).not.toBeNull();
      expect(loaded?.debugEgress).toBeUndefined();
      expect(loaded?.branch).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("sessionsDir (openlock-x8m8)", () => {
  // Before x8m8, sessionsDir() independently recomputed
  // `join(HOME, ".local", "state", "openlock", "sessions")` inline — an
  // OPENLOCK_STATE_DIR override would have worked for the gateway and
  // silently done nothing for session storage. This proves it now routes
  // through the same resolver as everything else.
  const oldOverride = process.env.OPENLOCK_STATE_DIR;

  afterEach(() => {
    if (oldOverride === undefined) delete process.env.OPENLOCK_STATE_DIR;
    else process.env.OPENLOCK_STATE_DIR = oldOverride;
  });

  it("is the default state dir's 'sessions' subdirectory with no override", () => {
    delete process.env.OPENLOCK_STATE_DIR;
    expect(sessionsDir()).toBe(join(defaultStateDir(), "sessions"));
  });

  it("honors OPENLOCK_STATE_DIR", () => {
    process.env.OPENLOCK_STATE_DIR = "/custom/state/dir";
    expect(sessionsDir()).toBe(join("/custom/state/dir", "sessions"));
  });
});
