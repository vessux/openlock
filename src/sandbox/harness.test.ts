import { describe, expect, it } from "bun:test";
import { HARNESSES, harnessLaunchArgv, resolveHarness, validateHarness } from "./harness";

describe("HARNESSES", () => {
  it("contains the four harnesses", () => {
    expect(HARNESSES.has("claude_code")).toBe(true);
    expect(HARNESSES.has("opencode")).toBe(true);
    expect(HARNESSES.has("pi")).toBe(true);
    expect(HARNESSES.has("copilot_cli")).toBe(true);
  });
});

describe("validateHarness", () => {
  it("returns the value when valid", () => {
    expect(validateHarness("opencode", "--harness")).toBe("opencode");
    expect(validateHarness("claude_code", "OPENLOCK_HARNESS")).toBe("claude_code");
    expect(validateHarness("pi", "--harness")).toBe("pi");
  });

  it("throws with source named for invalid values", () => {
    expect(() => validateHarness("foo", "--harness")).toThrow(/--harness/);
    expect(() => validateHarness("foo", "--harness")).toThrow(/"foo"/);
    expect(() => validateHarness("foo", "--harness")).toThrow(/claude_code/);
    expect(() => validateHarness("foo", "--harness")).toThrow(/opencode/);
    expect(() => validateHarness("foo", "--harness")).toThrow(/pi/);
  });
});

describe("harnessLaunchArgv", () => {
  it("returns claude argv for claude_code", () => {
    expect(harnessLaunchArgv("claude_code", [])).toEqual(["claude"]);
    expect(harnessLaunchArgv("claude_code", ["-p", "hello"])).toEqual(["claude", "-p", "hello"]);
  });

  it("returns opencode argv for opencode", () => {
    expect(harnessLaunchArgv("opencode", [])).toEqual(["opencode"]);
    expect(harnessLaunchArgv("opencode", ["run", "hello"])).toEqual(["opencode", "run", "hello"]);
  });

  it("returns pi argv for pi", () => {
    expect(harnessLaunchArgv("pi", [])).toEqual(["pi"]);
    expect(harnessLaunchArgv("pi", ["-p", "hello"])).toEqual(["pi", "-p", "hello"]);
  });

  it("returns copilot argv for copilot_cli", () => {
    expect(harnessLaunchArgv("copilot_cli", [])).toEqual(["copilot"]);
    expect(harnessLaunchArgv("copilot_cli", ["-p", "hello"])).toEqual(["copilot", "-p", "hello"]);
  });
});

describe("resolveHarness", () => {
  it("returns built-in default when everything is empty", () => {
    expect(resolveHarness({ cliFlag: undefined, env: {}, readGlobal: () => null })).toBe(
      "claude_code",
    );
  });

  it("CLI flag wins over env, global, and default", () => {
    expect(
      resolveHarness({
        cliFlag: "opencode",
        env: { OPENLOCK_HARNESS: "claude_code" },
        readGlobal: () => ({ defaultHarness: "claude_code" }),
      }),
    ).toBe("opencode");
  });

  it("env wins over global and default", () => {
    expect(
      resolveHarness({
        cliFlag: undefined,
        env: { OPENLOCK_HARNESS: "opencode" },
        readGlobal: () => ({ defaultHarness: "claude_code" }),
      }),
    ).toBe("opencode");
  });

  it("global wins over default", () => {
    expect(
      resolveHarness({
        cliFlag: undefined,
        env: {},
        readGlobal: () => ({ defaultHarness: "opencode" }),
      }),
    ).toBe("opencode");
  });

  it("project harness wins over global and default", () => {
    expect(
      resolveHarness({
        cliFlag: undefined,
        env: {},
        projectHarness: "opencode",
        readGlobal: () => ({ defaultHarness: "claude_code" }),
      }),
    ).toBe("opencode");
  });

  it("env wins over project harness", () => {
    expect(
      resolveHarness({
        cliFlag: undefined,
        env: { OPENLOCK_HARNESS: "claude_code" },
        projectHarness: "opencode",
        readGlobal: () => null,
      }),
    ).toBe("claude_code");
  });

  it("CLI flag wins over project harness", () => {
    expect(
      resolveHarness({
        cliFlag: "claude_code",
        env: {},
        projectHarness: "opencode",
        readGlobal: () => null,
      }),
    ).toBe("claude_code");
  });

  it("falls through to global when no project harness is set", () => {
    expect(
      resolveHarness({
        cliFlag: undefined,
        env: {},
        projectHarness: undefined,
        readGlobal: () => ({ defaultHarness: "opencode" }),
      }),
    ).toBe("opencode");
  });

  it("rejects invalid CLI flag", () => {
    expect(() => resolveHarness({ cliFlag: "foo", env: {}, readGlobal: () => null })).toThrow(
      /--harness/,
    );
  });

  it("rejects invalid env value", () => {
    expect(() =>
      resolveHarness({
        cliFlag: undefined,
        env: { OPENLOCK_HARNESS: "foo" },
        readGlobal: () => null,
      }),
    ).toThrow(/OPENLOCK_HARNESS/);
  });

  it("ignores empty CLI flag and empty env (no value, not invalid)", () => {
    expect(
      resolveHarness({ cliFlag: "", env: { OPENLOCK_HARNESS: "" }, readGlobal: () => null }),
    ).toBe("claude_code");
  });
});
