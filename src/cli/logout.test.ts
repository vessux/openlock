import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../providers/types";
import { readProvider, writeProvider } from "../tokens";
import { _logoutForTests } from "./logout";

let dir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-logout-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = dir;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(dir, { recursive: true, force: true });
});

/** Stand-in for an unreachable gateway. Never let a test in this file reach a
 * real one — it would delete the developer's own provider rows. */
const noGateway = async (): Promise<boolean> => false;

describe("_logoutForTests", () => {
  it("deletes the named provider", async () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-x" },
      created_at: "t",
    });
    await _logoutForTests({
      providerFlag: "openrouter",
      pick: async () => "openrouter" as ProviderId,
      clearGateway: noGateway,
    });
    expect(readProvider("openrouter")).toBeNull();
  });

  it("dispatches to picker when no flag", async () => {
    writeProvider("anthropic", {
      type: "claude",
      credentials: { ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BEARER_TOKEN: "Bearer x" },
      created_at: "t",
    });
    await _logoutForTests({
      providerFlag: undefined,
      pick: async () => "anthropic" as ProviderId,
      clearGateway: noGateway,
    });
    expect(readProvider("anthropic")).toBeNull();
  });

  it("rejects when no providers are stored", async () => {
    await expect(
      _logoutForTests({
        providerFlag: undefined,
        pick: async () => "anthropic" as ProviderId,
        clearGateway: noGateway,
      }),
    ).rejects.toThrow(/no providers/i);
  });

  // openlock-9ej: the gateway row is the copy a sandbox actually gets. A
  // local-only logout left a revoked token in service with no way to remove it.
  it("also clears the gateway row", async () => {
    writeProvider("anthropic", {
      type: "claude-oauth",
      credentials: { ANTHROPIC_BEARER_TOKEN: "x" },
      created_at: "t",
    });
    const cleared: string[] = [];
    await _logoutForTests({
      providerFlag: "anthropic",
      pick: async () => "anthropic" as ProviderId,
      clearGateway: async (name) => {
        cleared.push(name);
        return true;
      },
    });
    expect(cleared).toEqual(["anthropic"]);
    expect(readProvider("anthropic")).toBeNull();
  });

  it("still succeeds locally when the gateway is unreachable", async () => {
    writeProvider("anthropic", {
      type: "claude-oauth",
      credentials: { ANTHROPIC_BEARER_TOKEN: "x" },
      created_at: "t",
    });
    await expect(
      _logoutForTests({
        providerFlag: "anthropic",
        pick: async () => "anthropic" as ProviderId,
        clearGateway: async () => false,
      }),
    ).resolves.toBeUndefined();
    expect(readProvider("anthropic")).toBeNull();
  });
});
