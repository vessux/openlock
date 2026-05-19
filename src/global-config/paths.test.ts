import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { globalConfigPath } from "./paths";

const oldEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...oldEnv };
});

afterEach(() => {
  process.env = oldEnv;
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
