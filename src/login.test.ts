import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _loginForTests } from "./login";
import type { LoginIO, ProviderId } from "./providers/types";
import { readProvider } from "./tokens";

let dir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-login-"));
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

function makeIO(
  lines: string[],
  isTTY = false,
): LoginIO & { stdout: string[]; stderr: string[]; prompts: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const queue = [...lines];
  return {
    stdout: out,
    stderr: err,
    prompts,
    isTTY,
    async readLine(prompt: string) {
      prompts.push(prompt);
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

const TOKEN = "sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("login default_provider offer", () => {
  function run(opts: {
    io: LoginIO;
    currentDefault?: ProviderId;
    offerDefault?: boolean;
  }): Promise<string[]> {
    const persisted: string[] = [];
    return _loginForTests({
      providerFlag: "openrouter",
      io: opts.io,
      pick: async () => "openrouter" as ProviderId,
      offerDefault: opts.offerDefault,
      readDefaultProvider: () => opts.currentDefault,
      persistDefaultProvider: (id) => persisted.push(id),
    }).then(() => persisted);
  }

  it("offers to set default when none is set and persists on accept", async () => {
    const io = makeIO([TOKEN, "y"], true);
    const persisted = await run({ io });
    expect(persisted).toEqual(["openrouter"]);
    expect(io.prompts.some((p) => /set 'openrouter' as your default/i.test(p))).toBe(true);
  });

  it("treats an empty answer as accepting the set-default offer", async () => {
    const io = makeIO([TOKEN, ""], true);
    expect(await run({ io })).toEqual(["openrouter"]);
  });

  it("does not persist when the set-default offer is declined", async () => {
    const io = makeIO([TOKEN, "n"], true);
    expect(await run({ io })).toEqual([]);
  });

  it("does not prompt when the default already equals the logged-in provider", async () => {
    const io = makeIO([TOKEN], true);
    const persisted = await run({ io, currentDefault: "openrouter" });
    expect(persisted).toEqual([]);
    expect(io.prompts.some((p) => /default/i.test(p))).toBe(false);
  });

  it("prompts to switch when a different default exists and persists on accept", async () => {
    const io = makeIO([TOKEN, "y"], true);
    const persisted = await run({ io, currentDefault: "anthropic" });
    expect(persisted).toEqual(["openrouter"]);
    expect(io.prompts.some((p) => /change your default.*anthropic.*openrouter/i.test(p))).toBe(
      true,
    );
  });

  it("does not switch the default on an empty answer (switch defaults to no)", async () => {
    const io = makeIO([TOKEN, ""], true);
    expect(await run({ io, currentDefault: "anthropic" })).toEqual([]);
  });

  it("never prompts or persists when stdin is not a TTY", async () => {
    const io = makeIO([TOKEN], false);
    const persisted = await run({ io });
    expect(persisted).toEqual([]);
    expect(io.prompts.some((p) => /default/i.test(p))).toBe(false);
  });

  it("does not offer the default when offerDefault is false (setup owns it)", async () => {
    const io = makeIO([TOKEN], true);
    const persisted = await run({ io, offerDefault: false });
    expect(persisted).toEqual([]);
  });
});
