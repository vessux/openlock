import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _loginForTests } from "./login";
import type { LoginIO, ProviderId } from "./providers/types";
import { readProvider } from "./tokens";

let dir: string;
let originalHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-login-"));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

function makeIO(lines: string[]): LoginIO & { stdout: string[]; stderr: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const queue = [...lines];
  return {
    stdout: out,
    stderr: err,
    isTTY: false,
    async readLine() {
      const next = queue.shift();
      if (next === undefined) throw new Error("no more lines");
      return next;
    },
    writeStdout: (s) => out.push(s),
    writeStderr: (s) => err.push(s),
  };
}

describe("_loginForTests", () => {
  it("with --provider openrouter writes the openrouter record", async () => {
    const io = makeIO(["sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"]);
    await _loginForTests({
      providerFlag: "openrouter",
      io,
      pick: async () => "anthropic" as ProviderId,
    });
    expect(readProvider("openrouter")?.credentials.OPENROUTER_BEARER_TOKEN).toBe(
      "Bearer sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
  });

  it("bare login dispatches to the picker, then to that provider's loginInteractive", async () => {
    const io = makeIO(["sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"]);
    await _loginForTests({
      providerFlag: undefined,
      io,
      pick: async () => "openrouter" as ProviderId,
    });
    expect(readProvider("openrouter")).not.toBeNull();
  });

  it("rejects unknown provider flag", async () => {
    const io = makeIO([]);
    await expect(
      _loginForTests({
        providerFlag: "openai",
        io,
        pick: async () => "anthropic" as ProviderId,
      }),
    ).rejects.toThrow(/openai/);
  });
});
