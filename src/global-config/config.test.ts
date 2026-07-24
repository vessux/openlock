import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGlobalConfig, readGlobalConfigFrom } from "./index";
import { validateAndShape } from "./schema";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openlock-globalconfig-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseGlobalConfig", () => {
  test("parses default_harness: opencode", () => {
    expect(parseGlobalConfig("default_harness: opencode", "/x.yaml")).toEqual({
      defaultHarness: "opencode",
    });
  });

  test("parses default_harness: claude_code", () => {
    expect(parseGlobalConfig("default_harness: claude_code", "/x.yaml")).toEqual({
      defaultHarness: "claude_code",
    });
  });

  test("empty file returns empty object", () => {
    expect(parseGlobalConfig("", "/x.yaml")).toEqual({});
  });

  test("yaml with only comments returns empty object", () => {
    expect(parseGlobalConfig("# just a comment\n", "/x.yaml")).toEqual({});
  });

  test("rejects unknown top-level key", () => {
    expect(() => parseGlobalConfig("unknown_key: 1", "/x.yaml")).toThrow(/unknown_key/);
    expect(() => parseGlobalConfig("unknown_key: 1", "/x.yaml")).toThrow(/x\.yaml/);
  });

  test("rejects invalid default_harness value", () => {
    expect(() => parseGlobalConfig("default_harness: foo", "/x.yaml")).toThrow(/default_harness/);
    expect(() => parseGlobalConfig("default_harness: foo", "/x.yaml")).toThrow(/"foo"/);
  });

  test("rejects non-object root", () => {
    expect(() => parseGlobalConfig("- not an object\n", "/x.yaml")).toThrow(/object/);
  });

  test("rejects malformed YAML", () => {
    expect(() => parseGlobalConfig("default_harness: [unterminated", "/x.yaml")).toThrow();
  });
});

describe("default_provider parsing", () => {
  test("parses default_provider: openrouter", () => {
    expect(parseGlobalConfig("default_provider: openrouter", "/x.yaml")).toEqual({
      defaultProvider: "openrouter",
    });
  });

  test("rejects unknown provider", () => {
    expect(() => parseGlobalConfig("default_provider: openai", "/x.yaml")).toThrow(/openai/);
  });

  test("parses both default_harness and default_provider", () => {
    expect(
      parseGlobalConfig("default_harness: opencode\ndefault_provider: openrouter\n", "/x.yaml"),
    ).toEqual({
      defaultHarness: "opencode",
      defaultProvider: "openrouter",
    });
  });
});

describe("default_runtime", () => {
  it("accepts podman", () => {
    const cfg = validateAndShape({ default_runtime: "podman" }, "test");
    expect(cfg.defaultRuntime).toBe("podman");
  });
  it("accepts docker", () => {
    const cfg = validateAndShape({ default_runtime: "docker" }, "test");
    expect(cfg.defaultRuntime).toBe("docker");
  });
  it("rejects unknown runtime", () => {
    expect(() => validateAndShape({ default_runtime: "nerdctl" }, "test")).toThrow(
      /not a recognized runtime/,
    );
  });
  it("rejects non-string", () => {
    expect(() => validateAndShape({ default_runtime: 42 }, "test")).toThrow(/must be a string/);
  });
});

describe("readGlobalConfigFrom", () => {
  test("returns null when file absent", () => {
    expect(readGlobalConfigFrom(join(tmp, "missing.yaml"))).toBeNull();
  });

  test("reads and parses an existing file", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, "default_harness: opencode\n");
    expect(readGlobalConfigFrom(path)).toEqual({ defaultHarness: "opencode" });
  });

  test("throws on invalid file contents", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, "default_harness: foo\n");
    expect(() => readGlobalConfigFrom(path)).toThrow(/default_harness/);
  });
});

describe("reap_idle", () => {
  it("accepts off", () => {
    expect(validateAndShape({ reap_idle: "off" }, "test").reapIdle).toBe("off");
  });
  it("accepts OFF case-insensitively", () => {
    expect(validateAndShape({ reap_idle: "OFF" }, "test").reapIdle).toBe("off");
  });
  it("accepts boolean false as off (defensive)", () => {
    expect(validateAndShape({ reap_idle: false }, "test").reapIdle).toBe("off");
  });
  it("parses 30m to milliseconds", () => {
    expect(validateAndShape({ reap_idle: "30m" }, "test").reapIdle).toBe(30 * 60 * 1000);
  });
  it("parses 2h to milliseconds", () => {
    expect(validateAndShape({ reap_idle: "2h" }, "test").reapIdle).toBe(2 * 60 * 60 * 1000);
  });
  it("parses 1d to milliseconds", () => {
    expect(validateAndShape({ reap_idle: "1d" }, "test").reapIdle).toBe(24 * 60 * 60 * 1000);
  });
  it("rejects on/true", () => {
    expect(() => validateAndShape({ reap_idle: "on" }, "test")).toThrow(/reap_idle/);
    expect(() => validateAndShape({ reap_idle: true }, "test")).toThrow(/reap_idle/);
  });
  it("rejects bare integer (must use a duration)", () => {
    expect(() => validateAndShape({ reap_idle: 1800000 }, "test")).toThrow(/reap_idle/);
  });
  it("rejects garbage duration", () => {
    expect(() => validateAndShape({ reap_idle: "30x" }, "test")).toThrow(/reap_idle/);
  });
});

describe("network_auto_reload (GH #75 / bd openlock-7er piece 1)", () => {
  it("is undefined when omitted (default suggest-only)", () => {
    expect(validateAndShape({}, "test").networkAutoReload).toBeUndefined();
  });
  it("accepts true", () => {
    expect(validateAndShape({ network_auto_reload: true }, "test").networkAutoReload).toBe(true);
  });
  it("accepts false", () => {
    expect(validateAndShape({ network_auto_reload: false }, "test").networkAutoReload).toBe(false);
  });
  it("rejects a non-boolean value", () => {
    expect(() => validateAndShape({ network_auto_reload: "yes" }, "test")).toThrow(
      /network_auto_reload/,
    );
  });
});
