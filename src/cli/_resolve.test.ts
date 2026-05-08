import { afterEach, describe, expect, it, mock } from "bun:test";
import type { SessionMeta } from "../sandbox/session-store";
import {
  findSessionsByPath as _realFindSessionsByPath,
  listAllSessions as _realListAllSessions,
  loadSession as _realLoadSession,
  removeSessionDir as _realRemoveSessionDir,
  saveSession as _realSaveSession,
  sessionDirById as _realSessionDirById,
  sessionsDir as _realSessionsDir,
  updateSessionMeta as _realUpdateSessionMeta,
} from "../sandbox/session-store";
import {
  defaultPickerIO as _realDefaultPickerIO,
  pickSession as _realPickSession,
} from "./_picker";

// Dereference live bindings immediately into plain const values so afterEach
// restore always uses the original implementations, not the mock-updated live bindings.
const realPickSession = _realPickSession;
const realDefaultPickerIO = _realDefaultPickerIO;
const realSessionsDir = _realSessionsDir;
const realSessionDirById = _realSessionDirById;
const realSaveSession = _realSaveSession;
const realLoadSession = _realLoadSession;
const realListAllSessions = _realListAllSessions;
const realFindSessionsByPath = _realFindSessionsByPath;
const realRemoveSessionDir = _realRemoveSessionDir;
const realUpdateSessionMeta = _realUpdateSessionMeta;

function makeMeta(id: string, name: string, repoPath: string): SessionMeta {
  return {
    id,
    name,
    repoPath,
    caps: [],
    image: "img",
    policy: "default",
    createdAt: "2026-05-09T00:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
  };
}

function makeStoreModule(sessions: SessionMeta[]) {
  return {
    sessionsDir: () => "/fake/sessions",
    sessionDirById: (base: string, id: string) => `${base}/${id}`,
    saveSession: () => {},
    loadSession: () => null,
    listAllSessions: () => sessions,
    findSessionsByPath: (_base: string, path: string) =>
      sessions.filter((s) => s.repoPath === path),
    removeSessionDir: () => {},
    updateSessionMeta: () => {},
  };
}

afterEach(async () => {
  // Restore _picker and session-store to real implementations to avoid
  // cross-file mock pollution. Bun 1.3 mock.module is permanent per-process;
  // re-registering with captured real values is the only way to restore.
  mock.module("./_picker", () => ({
    pickSession: realPickSession,
    defaultPickerIO: realDefaultPickerIO,
  }));
  mock.module("../sandbox/session-store", () => ({
    sessionsDir: realSessionsDir,
    sessionDirById: realSessionDirById,
    saveSession: realSaveSession,
    loadSession: realLoadSession,
    listAllSessions: realListAllSessions,
    findSessionsByPath: realFindSessionsByPath,
    removeSessionDir: realRemoveSessionDir,
    updateSessionMeta: realUpdateSessionMeta,
  }));
  // Yield so live-binding updates propagate before other files' tests run.
  await new Promise<void>((r) => setTimeout(r, 0));
});

describe("resolveSessionName picker integration", () => {
  it("delegates to picker when cwd matches more than one session", async () => {
    const cwd = "/fake/repo";
    const sessions = [makeMeta("a", "alpha", cwd), makeMeta("b", "beta", cwd)];

    mock.module("../sandbox/session-store", () => makeStoreModule(sessions));

    const pickerCalls: string[][] = [];
    mock.module("./_picker", () => ({
      pickSession: async (ss: SessionMeta[]) => {
        pickerCalls.push(ss.map((s) => s.name));
        return ss.find((s) => s.name === "beta") ?? null;
      },
      defaultPickerIO: () => ({}),
    }));

    const originalCwd = process.cwd;
    process.cwd = () => cwd;
    try {
      const { resolveSessionName } = await import(`./_resolve?t=${Date.now()}`);
      const name = await resolveSessionName(undefined, "stop");
      expect(name).toBe("beta");
      expect(pickerCalls).toEqual([["alpha", "beta"]]);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("delegates to picker over all sessions when cwd has no match but others exist", async () => {
    const cwd = "/fake/different";
    const sessions = [makeMeta("a", "alpha", "/fake/elsewhere")];

    mock.module("../sandbox/session-store", () => makeStoreModule(sessions));

    mock.module("./_picker", () => ({
      pickSession: async (ss: SessionMeta[]) => ss.find((s) => s.name === "alpha") ?? null,
      defaultPickerIO: () => ({}),
    }));

    const originalCwd = process.cwd;
    process.cwd = () => cwd;
    try {
      const { resolveSessionName } = await import(`./_resolve?t=${Date.now()}`);
      const name = await resolveSessionName(undefined, "shell");
      expect(name).toBe("alpha");
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("returns null with original error when picker is dismissed", async () => {
    const cwd = "/fake/repo";
    const sessions = [makeMeta("a", "alpha", cwd), makeMeta("b", "beta", cwd)];

    mock.module("../sandbox/session-store", () => makeStoreModule(sessions));

    mock.module("./_picker", () => ({
      pickSession: async () => null,
      defaultPickerIO: () => ({}),
    }));

    const originalCwd = process.cwd;
    process.cwd = () => cwd;
    try {
      const { resolveSessionName } = await import(`./_resolve?t=${Date.now()}`);
      const name = await resolveSessionName(undefined, "stop");
      expect(name).toBeNull();
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("returns the single cwd match without invoking picker", async () => {
    const cwd = "/fake/repo";
    const sessions = [makeMeta("a", "alpha", cwd)];

    mock.module("../sandbox/session-store", () => makeStoreModule(sessions));

    let pickerCalled = false;
    mock.module("./_picker", () => ({
      pickSession: async () => {
        pickerCalled = true;
        return null;
      },
      defaultPickerIO: () => ({}),
    }));

    const originalCwd = process.cwd;
    process.cwd = () => cwd;
    try {
      const { resolveSessionName } = await import(`./_resolve?t=${Date.now()}`);
      const name = await resolveSessionName(undefined, "stop");
      expect(name).toBe("alpha");
      expect(pickerCalled).toBe(false);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("returns null when no sessions exist anywhere", async () => {
    const cwd = "/fake/repo";

    mock.module("../sandbox/session-store", () => makeStoreModule([]));

    mock.module("./_picker", () => ({
      pickSession: async () => null,
      defaultPickerIO: () => ({}),
    }));

    const originalCwd = process.cwd;
    process.cwd = () => cwd;
    try {
      const { resolveSessionName } = await import(`./_resolve?t=${Date.now()}`);
      const name = await resolveSessionName(undefined, "stop");
      expect(name).toBeNull();
    } finally {
      process.cwd = originalCwd;
    }
  });
});
