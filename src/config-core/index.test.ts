import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitignoreCoversLocalConfig,
  knownConfigTokens,
  lintFolder,
  loadDeclaredCredentialsMerged,
} from "./index";

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

  it("hard-errors when policy injects a credential no provider supplies (openlock-8ir)", () => {
    writeFolder(
      "args: []\n",
      [
        "version: 1",
        "network_policies:",
        "  gh:",
        "    endpoints:",
        "      - host: api.github.com",
        "        port: 443",
        "        protocol: rest",
        "        rules: [{ allow: { method: GET, path: /** } }]",
        "        cred_inject:",
        "          inject:",
        "            - header: Authorization",
        "              from_credential: GITHUB_TOKEN",
        "",
      ].join("\n"),
    );
    const issues = lintFolder(root, { offline: true });
    expect(
      issues.some(
        (i) =>
          i.file === "policy.yaml" && i.severity === "error" && i.message.includes("GITHUB_TOKEN"),
      ),
    ).toBe(true);
  });

  it("passes the cross-check when a declared credentials: bundle supplies the injected credential", () => {
    writeFolder(
      [
        "credentials:",
        "  - name: github",
        "    values:",
        "      GITHUB_TOKEN: { from_env: GITHUB_TOKEN }",
        "",
      ].join("\n"),
      [
        "version: 1",
        "network_policies:",
        "  gh:",
        "    endpoints:",
        "      - host: api.github.com",
        "        port: 443",
        "        protocol: rest",
        "        rules: [{ allow: { method: GET, path: /** } }]",
        "        cred_inject:",
        "          inject:",
        "            - header: Authorization",
        "              from_credential: GITHUB_TOKEN",
        "",
      ].join("\n"),
    );
    expect(lintFolder(root, { offline: true })).toEqual([]);
  });

  it("hard-errors when a credentials[] bundle name collides with a built-in provider (openlock-8ir)", () => {
    writeFolder(
      ["credentials:", "  - name: anthropic", "    values:", "      X: { from_env: X }", ""].join(
        "\n",
      ),
      "version: 1\n",
    );
    const issues = lintFolder(root, { offline: false });
    expect(
      issues.some(
        (i) =>
          i.file === "config.yaml" &&
          i.severity === "error" &&
          i.path === "credentials[0].name" &&
          i.message.includes("anthropic"),
      ),
    ).toBe(true);
  });

  it("surfaces the name-collision error even when policy.yaml has an unrelated issue (independence)", () => {
    writeFolder(
      ["credentials:", "  - name: openrouter", "    values:", "      X: { from_env: X }", ""].join(
        "\n",
      ),
      "filesystem_policy: {}\n",
    );
    const issues = lintFolder(root, { offline: false });
    expect(issues.some((i) => i.file === "policy.yaml" && i.severity === "error")).toBe(true);
    expect(
      issues.some(
        (i) =>
          i.file === "config.yaml" &&
          i.severity === "error" &&
          i.path === "credentials[0].name" &&
          i.message.includes("openrouter"),
      ),
    ).toBe(true);
  });

  it("surfaces an unsupplied-credential error even when config.yaml has an unrelated filesystem issue (openlock-8ir regression)", () => {
    // config.yaml has a mounts: entry whose source doesn't exist on disk
    // (severity:"filesystem", non-blocking for the cross-check guard) AND
    // policy.yaml injects a credential nothing supplies. Before the fix,
    // parseManifest's mount-source check threw inside the cross-check's
    // try/catch and silently dropped the GITHUB_TOKEN error along with it.
    writeFolder(
      "mounts:\n  - source: nope\n    target: /sandbox/.openlock/x\n    type: copy-once\n",
      [
        "version: 1",
        "network_policies:",
        "  gh:",
        "    endpoints:",
        "      - host: api.github.com",
        "        port: 443",
        "        protocol: rest",
        "        rules: [{ allow: { method: GET, path: /** } }]",
        "        cred_inject:",
        "          inject:",
        "            - header: Authorization",
        "              from_credential: GITHUB_TOKEN",
        "",
      ].join("\n"),
    );
    const issues = lintFolder(root, { offline: false });
    expect(issues.some((i) => i.file === "config.yaml" && i.severity === "filesystem")).toBe(true);
    expect(
      issues.some(
        (i) =>
          i.file === "policy.yaml" && i.severity === "error" && i.message.includes("GITHUB_TOKEN"),
      ),
    ).toBe(true);
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

describe("config.local.yaml support", () => {
  let dir: string;
  function seed(files: Record<string, string>): void {
    const folder = join(dir, ".openlock");
    mkdirSync(folder, { recursive: true });
    for (const [n, b] of Object.entries(files)) writeFileSync(join(folder, n), b, "utf-8");
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "olcc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("attributes a config.local.yaml schema error to that file", () => {
    seed({
      "config.yaml": "args: [--x]\n",
      "config.local.yaml": "bogus_key: true\n",
      "policy.yaml": "version: 1\n",
    });
    const issues = lintFolder(dir, { offline: true });
    expect(issues.some((i) => i.file === "config.local.yaml" && i.severity === "error")).toBe(true);
  });

  it("merges credentials from both files", () => {
    seed({
      "config.yaml": "credentials:\n  - name: a\n    values: {}\n",
      "config.local.yaml": "credentials:\n  - name: b\n    values: {}\n",
    });
    const names = loadDeclaredCredentialsMerged(join(dir, ".openlock")).map((c) => c.name);
    expect(names).toEqual(["a", "b"]);
  });

  it("detects whether .gitignore covers config.local.yaml", () => {
    expect(gitignoreCoversLocalConfig(null)).toBe(false);
    expect(gitignoreCoversLocalConfig("node_modules\n")).toBe(false);
    expect(gitignoreCoversLocalConfig("node_modules\nconfig.local.yaml\n")).toBe(true);
    expect(gitignoreCoversLocalConfig("/config.local.yaml")).toBe(true);
  });
});
