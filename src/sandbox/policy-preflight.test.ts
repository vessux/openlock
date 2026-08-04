import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue } from "../config-core";
import { collectConfigPolicyIssues } from "../config-core";
import {
  collectSandboxPolicyIssues,
  decidePolicyPreflightAction,
  enforcePolicyPreflight,
  formatPolicyPreflightLines,
} from "./policy-preflight";

const errorIssue: Issue = {
  file: "policy.yaml",
  severity: "error",
  path: "network_policies.g.endpoints[0].cred_inject",
  message: "boom",
};
const warningIssue: Issue = {
  file: "policy.yaml",
  severity: "warning",
  path: "network_policies.g.endpoints[0].cred_inject",
  message: "hmm",
};

// openlock-j9t7 / D3: the reattach-warns-instead-of-blocking case is the one
// most at risk from a naive implementation (blocking on stale on-disk
// content that isn't even live in the running container) — both settings of
// policyWillBeApplied are covered explicitly below.
describe("decidePolicyPreflightAction", () => {
  it("blocks on an error issue when the policy will actually be applied (create/recreate/--rebuild)", () => {
    expect(decidePolicyPreflightAction([errorIssue], { policyWillBeApplied: true })).toEqual({
      block: true,
    });
  });

  it("does NOT block on an error issue on a plain reattach (policy not applied)", () => {
    expect(decidePolicyPreflightAction([errorIssue], { policyWillBeApplied: false })).toEqual({
      block: false,
    });
  });

  it("never blocks on warning-only issues, regardless of policyWillBeApplied", () => {
    expect(decidePolicyPreflightAction([warningIssue], { policyWillBeApplied: true })).toEqual({
      block: false,
    });
    expect(decidePolicyPreflightAction([warningIssue], { policyWillBeApplied: false })).toEqual({
      block: false,
    });
  });

  it("returns block:false for an empty issue set either way", () => {
    expect(decidePolicyPreflightAction([], { policyWillBeApplied: true })).toEqual({
      block: false,
    });
    expect(decidePolicyPreflightAction([], { policyWillBeApplied: false })).toEqual({
      block: false,
    });
  });
});

describe("formatPolicyPreflightLines", () => {
  it("returns [] for an empty issue set", () => {
    expect(formatPolicyPreflightLines([], { policyWillBeApplied: true })).toEqual([]);
    expect(formatPolicyPreflightLines([], { policyWillBeApplied: false })).toEqual([]);
  });

  it("headers a blocking issue as something this sandbox would ship with", () => {
    const lines = formatPolicyPreflightLines([errorIssue], { policyWillBeApplied: true });
    expect(lines[0]).toMatch(/blocking issue.*this sandbox would ship with/);
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
  });

  // The exact wording the driver asked to pin: a reattach warning must say
  // explicitly that it affects the NEXT rebuild, not the currently running
  // container — never implying the live sandbox has the defect.
  it("on a plain reattach, explicitly says the issue affects the next rebuild, not the running sandbox", () => {
    const lines = formatPolicyPreflightLines([errorIssue], { policyWillBeApplied: false });
    expect(lines[0]).toMatch(/do NOT affect the currently running sandbox/);
    expect(lines[0]).toMatch(/next rebuild/);
    expect(lines[0]).toContain("--rebuild");
  });

  it("headers non-blocking issues (warnings only, policy about to be applied) distinctly from the blocking case", () => {
    const lines = formatPolicyPreflightLines([warningIssue], { policyWillBeApplied: true });
    expect(lines[0]).toMatch(/non-blocking issue/);
    expect(lines[0]).not.toContain("this sandbox would ship with them");
  });
});

// openlock-j9t7: enforcePolicyPreflight's RETURN VALUE is what
// session.ts's resolveOrCreateSession threads out as
// ResolvedSession.policyWarningLines and runSandbox re-prints once the
// harness exits — resolveOrCreateSession itself has no direct unit test
// (heavy gateway/podman I/O, matching the existing untested-wiring
// precedent around enforceTlsTerminationHealthy), so this is where the
// "every non-blocking call yields its lines; the blocking call yields none"
// contract is actually verified. The rule is about whether a call is
// blocking, NOT about which lifecycle branch (create/reattach/recreate)
// made it — a prior version of this fix wrongly assumed only reattach
// needed its lines re-emitted; a fresh create with warning-only issues hits
// the identical "TUI destroys the pre-attach copy" failure, so that case is
// pinned explicitly below.
describe("enforcePolicyPreflight (threading contract for ResolvedSession.policyWarningLines)", () => {
  // Assertions below use deltas/tails against each spy's call list rather
  // than "not called at all": this file runs inside the shared `bun test`
  // process alongside ~1200 other tests, some of which log asynchronously,
  // so an absolute-zero assertion on a global like console.warn/error can
  // pick up unrelated activity that happens to land in the same tick. Deltas
  // and tail-matches are immune to that and still prove the real point. Do
  // NOT "tighten" these back into toHaveBeenCalledTimes(0)-style absolute
  // assertions — that's what caused the flake this comment is warning about.
  it("warn-only reattach (policyWillBeApplied:false) returns the formatted lines, prints them via console.warn, never exits", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const exitCallsBefore = exitSpy.mock.calls.length;
      const expected = formatPolicyPreflightLines([errorIssue], { policyWillBeApplied: false });
      const lines = enforcePolicyPreflight([errorIssue], { policyWillBeApplied: false });
      expect(lines).toEqual(expected);
      expect(lines.length).toBeGreaterThan(0);
      const printed = warnSpy.mock.calls.slice(-lines.length).map((c) => c[0]);
      expect(printed).toEqual(lines);
      expect(exitSpy.mock.calls.slice(exitCallsBefore)).not.toContainEqual([1]);
    } finally {
      warnSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  // The case the earlier spec got wrong: a fresh create is also
  // policyWillBeApplied:true, and warning-only issues there are just as
  // real as on reattach — this must yield non-empty lines for
  // reprintPolicyWarningsAfterAttach to re-emit, not [].
  it("a fresh create with warning-only issues (policyWillBeApplied:true, no errors) ALSO returns non-empty lines to re-emit", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const exitCallsBefore = exitSpy.mock.calls.length;
      const expected = formatPolicyPreflightLines([warningIssue], { policyWillBeApplied: true });
      const lines = enforcePolicyPreflight([warningIssue], { policyWillBeApplied: true });
      expect(lines).toEqual(expected);
      expect(lines.length).toBeGreaterThan(0);
      const printed = warnSpy.mock.calls.slice(-lines.length).map((c) => c[0]);
      expect(printed).toEqual(lines);
      expect(exitSpy.mock.calls.slice(exitCallsBefore)).not.toContainEqual([1]);
    } finally {
      warnSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("a fresh create with no issues at all (issues:[]) returns [] — nothing to re-emit, nothing printed", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const before = warnSpy.mock.calls.length;
      expect(enforcePolicyPreflight([], { policyWillBeApplied: true })).toEqual([]);
      expect(warnSpy.mock.calls.length).toBe(before);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the blocking case (policyWillBeApplied:true, an error issue) returns [], exits(1), and prints via console.error, not warn", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const warnBefore = warnSpy.mock.calls.length;
      const expected = formatPolicyPreflightLines([errorIssue], { policyWillBeApplied: true });
      const lines = enforcePolicyPreflight([errorIssue], { policyWillBeApplied: true });
      // Nothing for a (real-world unreachable, since process.exit(1) halts
      // first) caller to re-emit — the blocking contract is []; see
      // enforcePolicyPreflight's doc comment.
      expect(lines).toEqual([]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(warnSpy.mock.calls.length).toBe(warnBefore);
      const printed = errorSpy.mock.calls.slice(-expected.length).map((c) => c[0]);
      expect(printed).toEqual(expected);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("collectSandboxPolicyIssues", () => {
  it("reports the same issues collectConfigPolicyIssues would for a plain single-file fixture (openlock-64dl anchor)", () => {
    const root = mkdtempSync(join(tmpdir(), "openlock-policy-preflight-"));
    try {
      const folder = join(root, ".openlock");
      mkdirSync(folder, { recursive: true });
      const policyContent = [
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
      ].join("\n");
      writeFileSync(join(folder, "policy.yaml"), policyContent);
      writeFileSync(join(folder, "config.yaml"), "args: []\n");

      const viaSandbox = collectSandboxPolicyIssues(folder, join(folder, "policy.yaml"));
      const viaShared = collectConfigPolicyIssues({
        policyContent,
        hasConfigErr: false,
        configCredentials: [],
        localConfigCredentials: [],
      });
      expect(viaSandbox).toEqual(viaShared);
      // Sanity: this fixture really is the openlock-64dl shape (missing
      // value_prefix on a provider-owned inject) — a blocking error.
      expect(viaSandbox.some((i) => i.severity === "error" && i.message.includes("Bearer"))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] (never throws) when policy.yaml can't be read, e.g. a --policy override pointing elsewhere", () => {
    const folder = mkdtempSync(join(tmpdir(), "openlock-policy-preflight-missing-"));
    try {
      expect(collectSandboxPolicyIssues(folder, join(folder, "nope.yaml"))).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
