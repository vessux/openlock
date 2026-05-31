import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownConfigTokens, lintFolder } from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlock-folder-lint-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFolder(config: string, policy: string): void {
  mkdirSync(join(root, ".openlock"), { recursive: true });
  writeFileSync(join(root, ".openlock/config.yaml"), config);
  writeFileSync(join(root, ".openlock/policy.yaml"), policy);
}

describe("lintFolder", () => {
  it("errors for both files (with init hint) when .openlock/ is missing", () => {
    const issues = lintFolder(root, { offline: false });
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.file).sort()).toEqual(["config.yaml", "policy.yaml"]);
    expect(issues[0]?.message).toMatch(/no \.openlock\/ directory/);
    expect(issues.every((i) => /openlock init/.test(i.fix ?? ""))).toBe(true);
  });

  it("flags a missing policy.yaml while still linting config.yaml", () => {
    mkdirSync(join(root, ".openlock"), { recursive: true });
    writeFileSync(join(root, ".openlock/config.yaml"), "args: []\n");
    const issues = lintFolder(root, { offline: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe("policy.yaml");
    expect(issues[0]?.message).toMatch(/policy\.yaml not found/);
  });

  it("flags a missing config.yaml while still linting policy.yaml", () => {
    mkdirSync(join(root, ".openlock"), { recursive: true });
    writeFileSync(join(root, ".openlock/policy.yaml"), "version: 1\n");
    const issues = lintFolder(root, { offline: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe("config.yaml");
    expect(issues[0]?.message).toMatch(/config\.yaml not found/);
  });

  it("returns [] for a valid folder", () => {
    writeFolder("args: []\n", "version: 1\n");
    expect(lintFolder(root, { offline: false })).toEqual([]);
  });

  it("reports config and policy issues together, tagged by file", () => {
    writeFolder("caps: [js]\n", "filesystem_policy: {}\n");
    const issues = lintFolder(root, { offline: false });
    expect(issues.some((i) => i.file === "config.yaml")).toBe(true);
    expect(issues.some((i) => i.file === "policy.yaml")).toBe(true);
  });

  it("offline:true suppresses a missing-source filesystem issue", () => {
    writeFolder(
      "mounts:\n  - source: nope\n    target: /sandbox/.openlock/x\n    type: copy-once\n",
      "version: 1\n",
    );
    expect(lintFolder(root, { offline: true })).toEqual([]);
    expect(lintFolder(root, { offline: false }).some((i) => i.severity === "filesystem")).toBe(
      true,
    );
  });
});

describe("knownConfigTokens", () => {
  it("includes manifest keys, mount types, and distinctive policy keys", () => {
    const tokens = knownConfigTokens();
    // manifest
    expect(tokens).toContain("mounts");
    expect(tokens).toContain("args");
    expect(tokens).toContain("env");
    // mount entry + types
    expect(tokens).toContain("readOnly");
    expect(tokens).toContain("copy-refresh");
    expect(tokens).toContain("git-bundle");
    // distinctive policy keys
    expect(tokens).toContain("network_policies");
    expect(tokens).toContain("cred_inject");
    expect(tokens).toContain("strip_headers");
    expect(tokens).toContain("from_credential");
    expect(tokens).toContain("trust_check");
    expect(tokens).toContain("allowed_secrets");
    expect(tokens).toContain("include_workdir");
    expect(tokens).toContain("run_as_user");
  });

  it("returns a de-duplicated, sorted list", () => {
    const tokens = knownConfigTokens();
    expect(tokens).toEqual([...new Set(tokens)].sort());
  });
});
