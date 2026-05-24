import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../providers/types";
import { readProvider, writeProvider } from "../tokens";
import { _logoutForTests } from "./logout";

let dir: string;
let originalHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-logout-"));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

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
    });
    expect(readProvider("anthropic")).toBeNull();
  });

  it("rejects when no providers are stored", async () => {
    await expect(
      _logoutForTests({
        providerFlag: undefined,
        pick: async () => "anthropic" as ProviderId,
      }),
    ).rejects.toThrow(/no providers/i);
  });
});
