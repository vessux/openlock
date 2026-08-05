import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStateDir, forkDir, resolveStateDir } from "./paths";

describe("forkDir", () => {
  it("resolves to a sibling openshell-fork directory of src/", () => {
    expect(forkDir().endsWith(`${join("openlock", "openshell-fork")}`)).toBe(true);
  });
});

describe("defaultStateDir / resolveStateDir (openlock-x8m8)", () => {
  const oldHome = process.env.HOME;
  const oldOverride = process.env.OPENLOCK_STATE_DIR;

  beforeEach(() => {
    process.env.HOME = "/home/test-user";
    delete process.env.OPENLOCK_STATE_DIR;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldOverride === undefined) delete process.env.OPENLOCK_STATE_DIR;
    else process.env.OPENLOCK_STATE_DIR = oldOverride;
  });

  it("defaultStateDir is HOME-relative", () => {
    expect(defaultStateDir()).toBe(join("/home/test-user", ".local", "state", "openlock"));
  });

  it("falls back to os.homedir() when HOME is unset", () => {
    delete process.env.HOME;
    expect(defaultStateDir()).toBe(join(homedir(), ".local", "state", "openlock"));
  });

  it("resolveStateDir() with nothing set returns the default", () => {
    expect(resolveStateDir()).toBe(defaultStateDir());
  });

  it("resolveStateDir() honors OPENLOCK_STATE_DIR over the default", () => {
    process.env.OPENLOCK_STATE_DIR = "/custom/state/dir";
    expect(resolveStateDir()).toBe("/custom/state/dir");
  });

  it("resolveStateDir(explicit) wins over OPENLOCK_STATE_DIR", () => {
    process.env.OPENLOCK_STATE_DIR = "/custom/state/dir";
    expect(resolveStateDir("/explicit/dir")).toBe("/explicit/dir");
  });

  it("does NOT honor XDG_STATE_HOME (deliberate — see resolveStateDir's doc)", () => {
    const oldXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/xdg/state";
    try {
      expect(resolveStateDir()).toBe(defaultStateDir());
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldXdg;
    }
  });
});
