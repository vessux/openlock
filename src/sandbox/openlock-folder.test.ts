import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readConfig } from "./openlock-folder";

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
