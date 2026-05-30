import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import { _ensureProviderForTests, providerExistsInGateway } from "./ensure-provider";

let dir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-ensure-"));
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

describe("providerExistsInGateway", () => {
  const tableStdout =
    "\x1b[1mNAME      \x1b[0m  \x1b[1mTYPE   \x1b[0m  \x1b[1mCREDENTIAL_KEYS\x1b[0m  \x1b[1mCONFIG_KEYS\x1b[0m\n" +
    "anthropic   claude-code  2                0\n" +
    "openrouter  generic      1                0\n";
  it("matches a row's first column against the provider id (ANSI-tolerant)", () => {
    expect(providerExistsInGateway(tableStdout, "openrouter")).toBe(true);
    expect(providerExistsInGateway(tableStdout, "anthropic")).toBe(true);
  });
  it("returns false when the name is absent", () => {
    const onlyAnthropic =
      "NAME      TYPE         CREDENTIAL_KEYS  CONFIG_KEYS\nanthropic claude-code  2                0\n";
    expect(providerExistsInGateway(onlyAnthropic, "openrouter")).toBe(false);
  });
  it("does not match substring-only collisions", () => {
    const tricky = "NAME    TYPE\nopenrouter-other  generic\n";
    expect(providerExistsInGateway(tricky, "openrouter")).toBe(false);
  });
});

describe("_ensureProviderForTests", () => {
  function makeShell(state: { existing: string[] }) {
    const calls: string[][] = [];
    return {
      calls,
      shell: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "provider" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: `NAME  TYPE\n${state.existing.map((n) => `${n}  generic`).join("\n")}\n`,
            stderr: "",
          };
        }
        // create / update: pretend success and mutate state for create
        if (args[1] === "create") state.existing.push(args[args.indexOf("--name") + 1]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  }

  it("creates a new provider when absent", async () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-x" },
      created_at: "t",
    });
    const m = makeShell({ existing: [] });
    await _ensureProviderForTests("openrouter", m.shell);
    // First call is `provider list`, second is `provider create ...`
    expect(m.calls[1][1]).toBe("create");
    expect(m.calls[1]).toContain("--name");
    expect(m.calls[1]).toContain("openrouter");
    expect(m.calls[1]).toContain("--credential");
    expect(m.calls[1]).toContain("OPENROUTER_BEARER_TOKEN=Bearer sk-or-v1-x");
  });

  it("updates an existing provider (no --type on update)", async () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-y" },
      created_at: "t",
    });
    const m = makeShell({ existing: ["openrouter"] });
    await _ensureProviderForTests("openrouter", m.shell);
    expect(m.calls[1][1]).toBe("update");
    expect(m.calls[1]).not.toContain("--type");
  });

  it("throws when no credentials are stored", async () => {
    const m = makeShell({ existing: [] });
    await expect(_ensureProviderForTests("openrouter", m.shell)).rejects.toThrow(/No credentials/);
  });
});
