import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  readFileSync as fsReadFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicyContent } from "./default-policies";
import {
  configPath,
  copyDefaultPolicy,
  policyPath,
  readConfig,
  resolveOpenlockFolder,
  writeConfig,
} from "./openlock-folder";

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
    expect(readConfig(folder)).toEqual({ caps: ["js", "py"], mounts: [], args: [], env: {} });
  });

  it("returns empty caps when caps key omitted", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "{}\n");
    expect(readConfig(folder)).toEqual({ caps: [], mounts: [], args: [], env: {} });
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

  it("parses mounts/args/env when present", () => {
    const folder = join(workDir, ".openlock");
    const src = join(workDir, "seed-src");
    mkdirSync(folder);
    mkdirSync(src);
    writeFileSync(
      join(folder, "config.yaml"),
      `caps: [js]
mounts:
  - source: ${src}
    target: /sandbox/.openlock/skills
    type: copy-once
args: ["--plugin-dir", "/sandbox/.openlock/skills"]
env:
  FOO: bar
`,
    );
    const cfg = readConfig(folder);
    expect(cfg.caps).toEqual(["js"]);
    expect(cfg.mounts).toEqual([
      { source: src, target: "/sandbox/.openlock/skills", type: "copy-once" },
    ]);
    expect(cfg.args).toEqual(["--plugin-dir", "/sandbox/.openlock/skills"]);
    expect(cfg.env).toEqual({ FOO: "bar" });
  });

  it("defaults mounts/args/env to empty when omitted", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "caps: [js]\n");
    const cfg = readConfig(folder);
    expect(cfg.mounts).toEqual([]);
    expect(cfg.args).toEqual([]);
    expect(cfg.env).toEqual({});
  });

  it("throws when args is not a list of strings", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "args: [1, 2, 3]\n");
    expect(() => readConfig(folder)).toThrow(/args/);
  });

  it("throws when env values are not strings", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(join(folder, "config.yaml"), "env:\n  K: 42\n");
    expect(() => readConfig(folder)).toThrow(/env/);
  });

  it("throws when mounts is invalid (propagates parseMounts error)", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "config.yaml"),
      "mounts:\n  - source: /nope\n    target: /sandbox/.openlock/x\n    type: copy-once\n",
    );
    expect(() => readConfig(folder)).toThrow(/does not exist/);
  });
});

describe("writeConfig", () => {
  it("writes caps as a yaml mapping that readConfig can round-trip", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeConfig(folder, { caps: ["js"] });
    expect(readConfig(folder)).toEqual({ caps: ["js"], mounts: [], args: [], env: {} });
  });

  it("writes empty caps as an empty list", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    writeConfig(folder, { caps: [] });
    expect(readConfig(folder)).toEqual({ caps: [], mounts: [], args: [], env: {} });
  });

  it("creates the .openlock directory if it does not yet exist", () => {
    const folder = join(workDir, ".openlock");
    writeConfig(folder, { caps: ["py"] });
    expect(readConfig(folder)).toEqual({ caps: ["py"], mounts: [], args: [], env: {} });
  });
});

describe("copyDefaultPolicy", () => {
  it("copies the shipped default for the given caps to .openlock/policy.yaml", () => {
    const folder = join(workDir, ".openlock");
    mkdirSync(folder);
    copyDefaultPolicy(folder, ["js", "py"]);
    const dest = policyPath(folder);
    expect(existsSync(dest)).toBe(true);
    expect(fsReadFileSync(dest, "utf-8")).toEqual(defaultPolicyContent(["js", "py"]));
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
    expect(fsReadFileSync(policyPath(folder), "utf-8")).toEqual(defaultPolicyContent(["js"]));
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
    expect(readConfig(folder)).toEqual({ caps: ["js"], mounts: [], args: [], env: {} });
  });

  it("first-run: empty repo -> caps = [] and uses default.yaml", () => {
    const result = resolveOpenlockFolder(workDir);
    expect(result.origin).toBe("first-run");
    expect(result.caps).toEqual([]);
    expect(fsReadFileSync(result.policyPath, "utf-8")).toEqual(defaultPolicyContent([]));
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
    expect(readConfig(folder)).toEqual({ caps: ["js"], mounts: [], args: [], env: {} });
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
    expect(fsReadFileSync(result.policyPath, "utf-8")).toEqual(defaultPolicyContent(["py"]));
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
