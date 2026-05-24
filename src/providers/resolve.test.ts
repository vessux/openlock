import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import { _resetDeprecationHintForTests, resolveProvider } from "./resolve";

let dir: string;
let originalHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-resolve-"));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
  _resetDeprecationHintForTests();
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

const noGlobal = () => null;

describe("resolveProvider precedence", () => {
  it("CLI flag wins", () => {
    expect(
      resolveProvider({
        harness: "opencode",
        cliFlag: "openrouter",
        env: { OPENLOCK_PROVIDER: "anthropic" },
        readGlobalConfig: () => ({ defaultProvider: "anthropic" }),
      }),
    ).toBe("openrouter");
  });

  it("env var wins over global config", () => {
    expect(
      resolveProvider({
        harness: "opencode",
        cliFlag: undefined,
        env: { OPENLOCK_PROVIDER: "openrouter" },
        readGlobalConfig: () => ({ defaultProvider: "anthropic" }),
      }),
    ).toBe("openrouter");
  });

  it("global config used when neither flag nor env set", () => {
    expect(
      resolveProvider({
        harness: "opencode",
        cliFlag: undefined,
        env: {},
        readGlobalConfig: () => ({ defaultProvider: "anthropic" }),
      }),
    ).toBe("anthropic");
  });
});

describe("resolveProvider compatibility", () => {
  it("rejects openrouter for claude_code", () => {
    expect(() =>
      resolveProvider({
        harness: "claude_code",
        cliFlag: "openrouter",
        env: {},
        readGlobalConfig: noGlobal,
      }),
    ).toThrow(/not compatible/);
  });
});

describe("resolveProvider missing-signal cases", () => {
  it("auto-defaults to anthropic for claude_code when an anthropic record exists (backward compat)", () => {
    writeProvider("anthropic", {
      type: "claude",
      credentials: { ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BEARER_TOKEN: "Bearer x" },
      created_at: "t",
    });
    expect(
      resolveProvider({
        harness: "claude_code",
        cliFlag: undefined,
        env: {},
        readGlobalConfig: noGlobal,
      }),
    ).toBe("anthropic");
  });

  it("errors clearly for opencode when no provider is set", () => {
    expect(() =>
      resolveProvider({
        harness: "opencode",
        cliFlag: undefined,
        env: {},
        readGlobalConfig: noGlobal,
      }),
    ).toThrow(/No provider selected/);
  });

  it("errors for claude_code when no anthropic record either", () => {
    expect(() =>
      resolveProvider({
        harness: "claude_code",
        cliFlag: undefined,
        env: {},
        readGlobalConfig: noGlobal,
      }),
    ).toThrow(/No provider selected/);
  });
});
