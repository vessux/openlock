import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  _resetConfigDirWarningForTests,
  defaultStateDir,
  forkDir,
  resolveConfigDir,
  resolveStateDir,
} from "./paths";

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

describe("resolveConfigDir (openlock-6pwu)", () => {
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldOverride = process.env.OPENLOCK_CONFIG_DIR;

  beforeEach(() => {
    process.env.HOME = "/home/test-user";
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENLOCK_CONFIG_DIR;
    _resetConfigDirWarningForTests();
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldOverride === undefined) delete process.env.OPENLOCK_CONFIG_DIR;
    else process.env.OPENLOCK_CONFIG_DIR = oldOverride;
    _resetConfigDirWarningForTests();
  });

  it("with nothing set, resolves exactly as before: $HOME/.config/openlock", () => {
    expect(resolveConfigDir()).toBe(join("/home/test-user", ".config", "openlock"));
  });

  it("with nothing set, honors XDG_CONFIG_HOME/openlock exactly as before", () => {
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    expect(resolveConfigDir()).toBe(join("/custom/xdg", "openlock"));
  });

  it("OPENLOCK_CONFIG_DIR set is used AS-IS, with no 'openlock' suffix appended", () => {
    process.env.OPENLOCK_CONFIG_DIR = "/scratch/cfg";
    const warn = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveConfigDir()).toBe("/scratch/cfg");
    } finally {
      warn.mockRestore();
    }
  });

  it("OPENLOCK_CONFIG_DIR set to an empty string is treated as unset", () => {
    process.env.OPENLOCK_CONFIG_DIR = "";
    expect(resolveConfigDir()).toBe(join("/home/test-user", ".config", "openlock"));
  });

  it("OPENLOCK_CONFIG_DIR wins over XDG_CONFIG_HOME when both are set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    process.env.OPENLOCK_CONFIG_DIR = "/scratch/cfg";
    const warn = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveConfigDir()).toBe("/scratch/cfg");
    } finally {
      warn.mockRestore();
    }
  });

  it("prints a one-time stderr notice naming the effective dir when the override is active", () => {
    process.env.OPENLOCK_CONFIG_DIR = "/scratch/cfg";
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      resolveConfigDir();
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0]?.[0]).toContain("/scratch/cfg");
      expect(err.mock.calls[0]?.[0]).toContain("OPENLOCK_CONFIG_DIR");
    } finally {
      err.mockRestore();
    }
  });

  it("does NOT re-print the notice on repeated calls within the same process", () => {
    process.env.OPENLOCK_CONFIG_DIR = "/scratch/cfg";
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      resolveConfigDir();
      resolveConfigDir();
      resolveConfigDir();
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it("never writes the notice to stdout", () => {
    process.env.OPENLOCK_CONFIG_DIR = "/scratch/cfg";
    const err = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      resolveConfigDir();
      expect(err).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});
