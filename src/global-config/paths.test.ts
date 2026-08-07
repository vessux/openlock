import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { _resetConfigDirWarningForTests } from "../paths";
import { globalConfigPath } from "./paths";

const oldEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...oldEnv };
  _resetConfigDirWarningForTests();
});

afterEach(() => {
  process.env = oldEnv;
  _resetConfigDirWarningForTests();
});

describe("globalConfigPath", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    delete process.env.HOME;
    process.env.HOME = "/home/user";
    expect(globalConfigPath()).toBe("/custom/xdg/openlock/config.yaml");
  });

  test("falls back to $HOME/.config when XDG_CONFIG_HOME unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/user";
    expect(globalConfigPath()).toBe("/home/user/.config/openlock/config.yaml");
  });
});

describe("globalConfigPath honors OPENLOCK_CONFIG_DIR (openlock-6pwu)", () => {
  test("resolves under the override dir, used AS-IS with no 'openlock' suffix", () => {
    process.env.OPENLOCK_CONFIG_DIR = "/scratch/cfg";
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(globalConfigPath()).toBe("/scratch/cfg/config.yaml");
    } finally {
      err.mockRestore();
    }
  });

  test("empty string is treated as unset", () => {
    process.env.OPENLOCK_CONFIG_DIR = "";
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/user";
    expect(globalConfigPath()).toBe("/home/user/.config/openlock/config.yaml");
  });

  test("wins over XDG_CONFIG_HOME when both are set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    process.env.OPENLOCK_CONFIG_DIR = "/scratch/cfg";
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(globalConfigPath()).toBe("/scratch/cfg/config.yaml");
    } finally {
      err.mockRestore();
    }
  });
});
