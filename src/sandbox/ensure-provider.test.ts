import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import { _ensureProviderForTests, providerExistsInGateway } from "./ensure-provider";

let dir: string;
let originalHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-ensure-"));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("providerExistsInGateway", () => {
  it("returns true when stdout contains name=<id>", () => {
    expect(
      providerExistsInGateway("name=anthropic type=claude\nname=openrouter ...\n", "openrouter"),
    ).toBe(true);
  });
  it("returns false for absent name", () => {
    expect(providerExistsInGateway("name=anthropic type=claude\n", "openrouter")).toBe(false);
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
            stdout: state.existing.map((n) => `name=${n}`).join("\n"),
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
      credentials: { OPENROUTER_API_KEY: "sk-or-v1-x" },
      created_at: "t",
    });
    const m = makeShell({ existing: [] });
    await _ensureProviderForTests("openrouter", m.shell);
    // First call is `provider list`, second is `provider create ...`
    expect(m.calls[1][1]).toBe("create");
    expect(m.calls[1]).toContain("--name");
    expect(m.calls[1]).toContain("openrouter");
    expect(m.calls[1]).toContain("--credential");
    expect(m.calls[1]).toContain("OPENROUTER_API_KEY=sk-or-v1-x");
  });

  it("updates an existing provider (no --type on update)", async () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_API_KEY: "sk-or-v1-y" },
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
