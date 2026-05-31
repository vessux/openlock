import { describe, expect, it } from "bun:test";
import { compatibleProviders, flagSchema, runSetup, type SetupDeps } from "./setup";

describe("setup flagSchema", () => {
  it("declares --help only", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
  });
});

describe("compatibleProviders", () => {
  it("returns only providers whose compatibleHarnesses include the harness", () => {
    const ids = compatibleProviders("claude_code");
    expect(ids).toContain("anthropic");
    expect(ids.every((id) => typeof id === "string")).toBe(true);
  });
});

describe("runSetup", () => {
  it("persists runtime, harness, and provider in order; login before default_provider", async () => {
    const persisted: Array<[string, string]> = [];
    const deps: SetupDeps = {
      io: {
        isTTY: true,
        write: () => {},
        select: async (_q, opts, def) => opts[def].value,
      },
      readGlobal: () => null,
      persist: (k, v) => persisted.push([k, v]),
      pickRuntime: async () => "podman",
      loginForProvider: async (id) => {
        persisted.push(["__login", id]);
      },
    };
    const code = await runSetup(deps);
    expect(code).toBe(0);
    expect(persisted).toContainEqual(["default_runtime", "podman"]);
    expect(persisted.some(([k]) => k === "default_harness")).toBe(true);
    expect(persisted.some(([k]) => k === "default_provider")).toBe(true);
    const loginIdx = persisted.findIndex(([k]) => k === "__login");
    const provIdx = persisted.findIndex(([k]) => k === "default_provider");
    expect(loginIdx).toBeLessThan(provIdx);
  });

  it("returns 1 and persists nothing in a non-TTY", async () => {
    const persisted: Array<[string, string]> = [];
    const deps: SetupDeps = {
      io: { isTTY: false, write: () => {}, select: async (_q, opts, def) => opts[def].value },
      readGlobal: () => null,
      persist: (k, v) => persisted.push([k, v]),
      pickRuntime: async () => "podman",
      loginForProvider: async () => {},
    };
    expect(await runSetup(deps)).toBe(1);
    expect(persisted).toEqual([]);
  });

  it("preselects the persisted harness on re-run", async () => {
    const persisted: Array<[string, string]> = [];
    const deps: SetupDeps = {
      io: { isTTY: true, write: () => {}, select: async (_q, opts, def) => opts[def].value },
      readGlobal: () => ({ defaultHarness: "opencode" }),
      persist: (k, v) => persisted.push([k, v]),
      pickRuntime: async () => "podman",
      loginForProvider: async () => {},
    };
    await runSetup(deps);
    expect(persisted).toContainEqual(["default_harness", "opencode"]);
  });
});
