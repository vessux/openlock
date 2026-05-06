import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync as fsReadFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readConfig,
  writeConfig,
  copyDefaultPolicy,
  resolveOpenlockFolder,
  policyPath,
  configPath,
} from "./openlock-folder";
import { selectPolicy } from "./select-policy";

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

  it("throws when caps is a scalar instead of a list", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "caps: js\n");
    expect(() => readConfig(folder)).toThrow(/must be a list/);
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

describe("copyDefaultPolicy", () => {
  it("copies the shipped default for the given caps to .openlock/policy.yaml", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    copyDefaultPolicy(folder, ["js", "py"]);
    const dest = policyPath(folder);
    const source = selectPolicy(["js", "py"]);
    expect(existsSync(dest)).toBe(true);
    expect(fsReadFileSync(dest, "utf-8")).toEqual(fsReadFileSync(source, "utf-8"));
  });

  it("creates the folder if missing", () => {
    const folder = join(workDir, ".openlock");
    copyDefaultPolicy(folder, []);
    expect(existsSync(policyPath(folder))).toBe(true);
  });

  it("overwrites an existing policy.yaml", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(policyPath(folder), "stale: true\n");
    copyDefaultPolicy(folder, ["js"]);
    const source = selectPolicy(["js"]);
    expect(fsReadFileSync(policyPath(folder), "utf-8")).toEqual(fsReadFileSync(source, "utf-8"));
  });
});

describe("resolveOpenlockFolder", () => {
  it("first-run: no .openlock, repo with package.json -> creates folder, writes config, copies policy", () => {
    writeFileSync(join(workDir, "package.json"), "{}\n");
    const result = resolveOpenlockFolder(workDir);
    const folder = join(workDir, ".openlock");
    expect(result.origin).toBe("first-run");
    expect(result.caps).toEqual(["js"]);
    expect(result.policyPath).toBe(join(folder, "policy.yaml"));
    expect(existsSync(join(folder, "config.yaml"))).toBe(true);
    expect(existsSync(join(folder, "policy.yaml"))).toBe(true);
    expect(readConfig(folder)).toEqual({ caps: ["js"] });
  });

  it("first-run: empty repo -> caps = [] and uses default.yaml", () => {
    const result = resolveOpenlockFolder(workDir);
    expect(result.origin).toBe("first-run");
    expect(result.caps).toEqual([]);
    const policySource = selectPolicy([]);
    expect(fsReadFileSync(result.policyPath, "utf-8")).toEqual(fsReadFileSync(policySource, "utf-8"));
  });

  it("subsequent-run: both files present -> reads caps from config, leaves files untouched", () => {
    writeFileSync(join(workDir, "package.json"), "{}\n");
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeConfig(folder, { caps: ["py"] });
    copyDefaultPolicy(folder, ["py"]);
    const policyMtimeBefore = statSync(policyPath(folder)).mtimeMs;

    const result = resolveOpenlockFolder(workDir);

    expect(result.origin).toBe("existing");
    expect(result.caps).toEqual(["py"]);
    expect(result.policyPath).toBe(policyPath(folder));
    expect(statSync(policyPath(folder)).mtimeMs).toBe(policyMtimeBefore);
  });

  it("recovery: config missing, policy present -> re-detects caps and writes config; policy untouched", () => {
    writeFileSync(join(workDir, "package.json"), "{}\n");
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    copyDefaultPolicy(folder, ["js", "py"]);
    const policyMtimeBefore = statSync(policyPath(folder)).mtimeMs;

    const result = resolveOpenlockFolder(workDir);

    expect(result.origin).toBe("restored-config");
    expect(result.caps).toEqual(["js"]);
    expect(readConfig(folder)).toEqual({ caps: ["js"] });
    expect(statSync(policyPath(folder)).mtimeMs).toBe(policyMtimeBefore);
  });

  it("recovery: policy missing, config present -> reads config caps, copies matching default; config untouched", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeConfig(folder, { caps: ["py"] });
    const configMtimeBefore = statSync(configPath(folder)).mtimeMs;

    const result = resolveOpenlockFolder(workDir);

    expect(result.origin).toBe("restored-policy");
    expect(result.caps).toEqual(["py"]);
    const source = selectPolicy(["py"]);
    expect(fsReadFileSync(result.policyPath, "utf-8")).toEqual(fsReadFileSync(source, "utf-8"));
    expect(statSync(configPath(folder)).mtimeMs).toBe(configMtimeBefore);
  });

  it("first-run: empty .openlock folder (both files missing) -> first-run flow materializes both", () => {
    writeFileSync(join(workDir, "package.json"), "{}\n");
    const folder = join(workDir, ".openlock");
    mkdirSync(folder); // empty .openlock dir, no files in it
    const result = resolveOpenlockFolder(workDir);
    expect(result.origin).toBe("first-run");
    expect(result.caps).toEqual(["js"]);
    expect(existsSync(join(folder, "config.yaml"))).toBe(true);
    expect(existsSync(join(folder, "policy.yaml"))).toBe(true);
  });
});
