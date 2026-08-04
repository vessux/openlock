import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSandboxPolicyIssues } from "../sandbox/policy-preflight";
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

  // openlock-j9t7: pins that checkCredentialNameCollisions runs UNCONDITIONALLY
  // on hasConfigErr, independent of whether policy.yaml exists at all —
  // unlike collectPolicyCrossCheckIssues, which early-returns when policy.yaml
  // is absent. A refactor that folds all cross-checks behind one
  // "policyContent present" gate would silently stop reporting a name
  // collision for a project with only a config.yaml — and no other test here
  // would catch that, since every other collision fixture also writes a
  // policy.yaml. This is the control-flow property the shared
  // collectConfigPolicyIssues (openlock-j9t7) must preserve.
  it("still reports a config.yaml name collision when policy.yaml does not exist at all", () => {
    mkdirSync(join(root, ".openlock"), { recursive: true });
    writeFileSync(
      join(root, ".openlock/config.yaml"),
      ["credentials:", "  - name: anthropic", "    values:", "      X: { from_env: X }", ""].join(
        "\n",
      ),
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

  // openlock-j9t7 drift guard: `openlock validate` (lintFolder) and the
  // sandbox create-time preflight (collectSandboxPolicyIssues) must report
  // the SAME issue set for the same on-disk fixture, since both now delegate
  // to the one shared collectConfigPolicyIssues. Anchored on the actual
  // openlock-64dl shape (PR #130): a committed policy.yaml whose
  // api.anthropic.com cred_inject omits `value_prefix: 'Bearer '` — the field
  // report that reached a colleague's terminal specifically because this
  // check was invisible outside `openlock validate`. If a future check is
  // added to collectConfigPolicyIssues but only one of these two call sites
  // is updated to pass it the right inputs, this test is what would catch
  // the surfaces silently diverging again.
  it("lintFolder and collectSandboxPolicyIssues report the same issues for the openlock-64dl value_prefix fixture", () => {
    writeFolder(
      "args: []\n",
      [
        "version: 1",
        "network_policies:",
        "  claude_code:",
        "    endpoints:",
        "      - host: api.anthropic.com",
        "        port: 443",
        "        protocol: rest",
        "        rules: [{ allow: { method: GET, path: /** } }]",
        "        cred_inject:",
        "          inject:",
        "            - header: Authorization",
        "              from_credential: ANTHROPIC_BEARER_TOKEN",
        "",
      ].join("\n"),
    );
    const viaValidate = lintFolder(root, { offline: true });
    const viaSandboxCreate = collectSandboxPolicyIssues(
      join(root, ".openlock"),
      join(root, ".openlock", "policy.yaml"),
    );
    expect(viaSandboxCreate.length).toBeGreaterThan(0);
    expect(
      viaSandboxCreate.some((i) => i.severity === "error" && i.message.includes("Bearer ")),
    ).toBe(true);
    // config.yaml here is clean (no manifest-schema issues, no credentials:
    // bundle), so validate's full result is exactly the policy-side issue
    // set the create path also produces — no filtering needed to compare.
    expect(viaValidate).toEqual(viaSandboxCreate);
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

  it("attributes a name-collision declared only in config.local.yaml to that file with a per-file index", () => {
    seed({
      // Unrelated clean credential first, so the local bundle would be
      // index 1 in a merged list — proves we use the per-file index 0.
      "config.yaml": "credentials:\n  - name: a\n    values: { X: { from_env: X } }\n",
      "config.local.yaml":
        "credentials:\n  - name: anthropic\n    values: { X: { from_env: X } }\n",
    });
    const issues = lintFolder(dir, { offline: true });
    expect(
      issues.some(
        (i) =>
          i.file === "config.local.yaml" &&
          i.severity === "error" &&
          i.path === "credentials[0].name" &&
          i.message.includes("anthropic"),
      ),
    ).toBe(true);
    // and NOT misattributed to config.yaml
    expect(
      issues.some(
        (i) =>
          i.file === "config.yaml" && i.severity === "error" && i.message.includes("anthropic"),
      ),
    ).toBe(false);
  });

  it("suppresses cross-checks when config.local.yaml has a schema error", () => {
    seed({
      // Without the local schema error, this would produce a name-collision
      // error (bundle "anthropic" in config.yaml).
      "config.yaml": "credentials:\n  - name: anthropic\n    values: { X: { from_env: X } }\n",
      "config.local.yaml": "bogus_key: true\n",
      "policy.yaml": "version: 1\n",
    });
    const issues = lintFolder(dir, { offline: true });
    expect(issues.some((i) => i.file === "config.local.yaml" && i.severity === "error")).toBe(true);
    expect(issues.some((i) => i.message.includes("anthropic"))).toBe(false);
  });

  it("catches a cross-file duplicate mount target that only appears when merged", () => {
    seed({
      "config.yaml":
        "mounts:\n  - source: .\n    target: /sandbox/.openlock/shared\n    type: bind\n",
      "config.local.yaml":
        "mounts:\n  - source: .\n    target: /sandbox/.openlock/shared\n    type: bind\n",
      "policy.yaml": "version: 1\n",
    });
    const issues = lintFolder(dir, { offline: true });
    expect(
      issues.some((i) => i.file === "config.local.yaml" && /duplicate target/i.test(i.message)),
    ).toBe(true);
  });

  it("does not double-report a duplicate target that already exists within config.yaml alone", () => {
    seed({
      "config.yaml":
        "mounts:\n  - source: .\n    target: /sandbox/.openlock/dup\n    type: bind\n  - source: .\n    target: /sandbox/.openlock/dup\n    type: bind\n",
      "config.local.yaml": "args: [--x]\n",
      "policy.yaml": "version: 1\n",
    });
    const issues = lintFolder(dir, { offline: true });
    const dupTargetIssues = issues.filter((i) => /duplicate target/i.test(i.message));
    expect(dupTargetIssues.length).toBe(1);
  });
});
