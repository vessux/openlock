import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta } from "../sandbox/session-store";
import { resolveSessionName } from "./_resolve";

let tmpRoot: string;
let originalHome: string | undefined;
let originalCwd: () => string;

function makeSession(id: string, name: string, repoPath: string) {
  const dir = join(tmpRoot, ".local", "state", "openlock", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id,
      name,
      repoPath,
      image: "img",
      policy: "default",
      createdAt: "2026-05-09T00:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
    }),
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "olresolve-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpRoot;
  originalCwd = process.cwd;
});

afterEach(() => {
  process.cwd = originalCwd;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveSessionName picker integration", () => {
  it("delegates to picker when cwd matches more than one session", async () => {
    const cwd = join(tmpRoot, "repo");
    mkdirSync(cwd, { recursive: true });
    process.cwd = () => cwd;
    makeSession("a", "alpha", cwd);
    makeSession("b", "beta", cwd);

    const calls: string[][] = [];
    const fakePick = async (sessions: SessionMeta[]) => {
      calls.push(sessions.map((s) => s.name));
      return sessions.find((s) => s.name === "beta") ?? null;
    };

    const name = await resolveSessionName(undefined, "stop", fakePick);
    expect(name).toBe("beta");
    // readdirSync order is filesystem-dependent (Linux ext4 vs macOS APFS)
    // — sort the captured names so the assertion is portable.
    expect(calls.length).toBe(1);
    expect([...calls[0]!].sort()).toEqual(["alpha", "beta"]);
  });

  it("delegates to picker over all sessions when cwd has no match but others exist", async () => {
    const cwd = join(tmpRoot, "different");
    mkdirSync(cwd, { recursive: true });
    process.cwd = () => cwd;
    makeSession("a", "alpha", join(tmpRoot, "elsewhere"));

    const fakePick = async (sessions: SessionMeta[]) =>
      sessions.find((s) => s.name === "alpha") ?? null;

    const name = await resolveSessionName(undefined, "shell", fakePick);
    expect(name).toBe("alpha");
  });

  it("returns null with original error when picker is dismissed", async () => {
    const cwd = join(tmpRoot, "repo");
    mkdirSync(cwd, { recursive: true });
    process.cwd = () => cwd;
    makeSession("a", "alpha", cwd);
    makeSession("b", "beta", cwd);

    const name = await resolveSessionName(undefined, "stop", async () => null);
    expect(name).toBeNull();
  });

  it("returns the single cwd match without invoking picker", async () => {
    const cwd = join(tmpRoot, "repo");
    mkdirSync(cwd, { recursive: true });
    process.cwd = () => cwd;
    makeSession("a", "alpha", cwd);

    let pickerCalled = false;
    const name = await resolveSessionName(undefined, "stop", async () => {
      pickerCalled = true;
      return null;
    });
    expect(name).toBe("alpha");
    expect(pickerCalled).toBe(false);
  });

  it("returns null when no sessions exist anywhere", async () => {
    const cwd = join(tmpRoot, "repo");
    mkdirSync(cwd, { recursive: true });
    process.cwd = () => cwd;

    const name = await resolveSessionName(undefined, "stop", async () => null);
    expect(name).toBeNull();
  });
});
