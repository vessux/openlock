import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCmd } from "./validate";

// openlock-j9t7: `validateCmd`'s printed output must stay byte-identical
// across the collectPolicyCrossCheckIssues/collectNameCollisionIssues →
// collectConfigPolicyIssues refactor (config-core/index.ts) and the
// renderIssue/SEVERITY_TAGS move into config-core/format.ts. This fixture
// deliberately hits all three rendered severities (error, filesystem,
// warning) across both files so a formatting regression in either moved
// piece would show up here, not just in the Issue[]-shape assertions in
// config-core/index.test.ts.
describe("validateCmd output (byte-identical guard, openlock-j9t7)", () => {
  let root: string;
  let logs: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openlock-validate-output-"));
    logs = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as never);

    const folder = join(root, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "config.yaml"),
      [
        "credentials:",
        "  - name: anthropic", // collides with a built-in provider id → error
        "    values:",
        "      X: { from_env: X }",
        "mounts:",
        "  - source: nope", // does not exist on disk → filesystem
        "    target: /sandbox/.openlock/x",
        "    type: copy-once",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(folder, "policy.yaml"),
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
        "              from_credential: GITHUB_TOKEN", // nothing supplies it → error
        "  claude:",
        "    endpoints:",
        "      - host: platform.claude.com", // known credential host, no cred_inject → warning
        "        port: 443",
        "        protocol: rest",
        "        rules: [{ allow: { method: GET, path: /** } }]",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prints the exact expected lines and exits 1", () => {
    validateCmd([root]);
    expect(logs).toEqual([
      "  config.yaml:",
      '    credentials[0].name: credential bundle name "anthropic" collides with a built-in provider — choose a different name',
      "      fix: rename this credentials[] entry to something other than: anthropic, openrouter",
      `    [fs] mounts[0].source: source ${join(root, "nope")} does not exist`,
      "  policy.yaml:",
      '    network_policies.gh.endpoints[0].cred_inject: credential "GITHUB_TOKEN" is injected by policy but no provider supplies it — declare it under credentials: in config.yaml (or attach the provider)',
      "      fix: add a credentials: entry whose values include GITHUB_TOKEN",
      '    [warn] network_policies.claude.endpoints[0].cred_inject: endpoint for host "platform.claude.com" in network_policies.claude allows traffic but declares no cred_inject, even though it is a known credential-bearing provider endpoint. Without cred_inject, the sandbox\'s PLACEHOLDER credential is forwarded verbatim; the real service typically answers 401/403, which agent harnesses treat as fatal — strictly worse than denying the connection.',
      "      fix: add a cred_inject block to this endpoint (mirror the other endpoint for platform.claude.com, or the provider's policyEndpoints), or remove/scope down the host if it is genuinely meant to stay unauthenticated",
      "config.yaml: 2 issues · policy.yaml: 2 issues",
    ]);
    expect(exitCode).toBe(1);
  });
});

// openlock-ztf item 1: the gitignore advisory only ever inspects
// .openlock/.gitignore (see gitignoreCoversLocalConfig's doc comment in
// config-core/index.ts) — it deliberately does NOT shell out to
// `git check-ignore`. A repo-root or parent .gitignore that also covers
// config.local.yaml is invisible to it, so the note fires anyway. This is a
// DOCUMENTED, ACCEPTED false positive (fails safe: over-warns rather than
// silently missing an uncovered file) — this test pins today's behaviour, not
// a desired end state. Do not "fix" it into passing by teaching the check
// about other .gitignore locations without updating this test's premise.
describe("validateCmd gitignore advisory — accepted false positive (openlock-ztf item 1)", () => {
  let root: string;
  let logs: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openlock-validate-gitignore-"));
    logs = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const folder = join(root, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), "args: [--x]\n");
    writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
    writeFileSync(join(folder, "config.local.yaml"), "args: [--y]\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("still fires when config.local.yaml is covered only by a repo-root .gitignore, not .openlock/.gitignore", () => {
    // Git itself would ignore config.local.yaml via this rule — but the
    // advisory never looks here, only at .openlock/.gitignore.
    writeFileSync(join(root, ".gitignore"), "config.local.yaml\n");
    validateCmd([root]);
    expect(logs.some((l) => l.startsWith("note: config.local.yaml is not listed"))).toBe(true);
  });
});
