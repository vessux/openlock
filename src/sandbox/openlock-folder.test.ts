import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readConfig, writeConfig } from "./openlock-folder";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openlock-folder-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("parses caps from config.yaml", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "caps: [js, py]\n");
    expect(readConfig(folder)).toEqual({ caps: ["js", "py"] });
  });

  it("returns empty caps when caps key omitted", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "{}\n");
    expect(readConfig(folder)).toEqual({ caps: [] });
  });

  it("throws when config.yaml is missing", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    expect(() => readConfig(folder)).toThrow(/config\.yaml/);
  });

  it("throws when caps contains an unknown value", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "caps: [rust]\n");
    expect(() => readConfig(folder)).toThrow(/unknown cap/);
  });
});

describe("writeConfig", () => {
  it("writes caps as a yaml mapping that readConfig can round-trip", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeConfig(folder, { caps: ["js"] });
    expect(readConfig(folder)).toEqual({ caps: ["js"] });
  });

  it("writes empty caps as an empty list", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeConfig(folder, { caps: [] });
    expect(readConfig(folder)).toEqual({ caps: [] });
  });

  it("creates the .openlock directory if it does not yet exist", () => {
    const folder = join(workDir, ".openlock");
    writeConfig(folder, { caps: ["py"] });
    expect(readConfig(folder)).toEqual({ caps: ["py"] });
  });
});
