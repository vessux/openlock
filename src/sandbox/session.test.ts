import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialBundle } from "../config-core";
import {
  attachedCredentialBundleNames,
  buildSetupCmd,
  pickSessionHarness,
  resolveRepoPolicy,
  stageProviderSandboxFiles,
  userExplicitlyPickedHarness,
  warnOnUnattachedCredentialBundles,
} from "./session";

describe("buildSetupCmd", () => {
  it("single-quotes mount targets so they cannot inject shell commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-inj-"));
    const marker = join(dir, "PWNED");
    // Both a plain injection and one hidden in an otherwise-legal odd-char path
    // (spaces/colons are a supported target feature — see scaffold quoting).
    for (const target of [
      `/sandbox/.openlock/x$(touch ${marker})`,
      `/sandbox/.openlock/a: b$(touch ${marker})`,
      `/sandbox/.openlock/x\`touch ${marker}\``,
    ]) {
      const cmd = buildSetupCmd([{ source: "repo", target, type: "git-bundle" }], undefined);
      // Drop the trailing `exec sleep infinity` so the script terminates. If the
      // target were interpolated unquoted, the `$(touch ...)` / backticks would
      // fire during the `[ -d ... ]` test regardless of git; the marker proves
      // it did not.
      const runnable = cmd
        .split(" ; ")
        .filter((l) => !l.startsWith("exec sleep"))
        .join(" ; ");
      const proc = Bun.spawn(["bash", "-c", runnable], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("quotes the workdir branch flag", () => {
    const cmd = buildSetupCmd(
      [{ source: "repo", target: "/sandbox/repo", type: "git-bundle" }],
      "feature/x",
    );
    expect(cmd).toContain("-b 'feature/x'");
  });
});

describe("resolveRepoPolicy", () => {
  function projectWith(configBody: string): string {
    const proj = mkdtempSync(join(tmpdir(), "rrp-"));
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), configBody);
    writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
    writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
    return proj;
  }

  it("carries the persisted harness from config.yaml", () => {
    const proj = projectWith("harness: opencode\nmounts: []\n");
    expect(resolveRepoPolicy(proj).harness).toBe("opencode");
  });

  it("leaves harness undefined when config.yaml omits it", () => {
    const proj = projectWith("mounts: []\n");
    expect(resolveRepoPolicy(proj).harness).toBeUndefined();
  });

  it("leaves harness undefined on the --policy override path (no .openlock read)", () => {
    expect(resolveRepoPolicy("/nonexistent", "/tmp/some-policy.yaml").harness).toBeUndefined();
  });

  // openlock-251
  it("carries the persisted cpu/memory limits from config.yaml", () => {
    const proj = projectWith('cpu: "2"\nmemory: "4Gi"\nmounts: []\n');
    const repo = resolveRepoPolicy(proj);
    expect(repo.cpu).toBe("2");
    expect(repo.memory).toBe("4Gi");
  });

  it("leaves cpu/memory undefined when config.yaml omits them, and on the --policy override path", () => {
    const proj = projectWith("mounts: []\n");
    const repo = resolveRepoPolicy(proj);
    expect(repo.cpu).toBeUndefined();
    expect(repo.memory).toBeUndefined();

    const overridden = resolveRepoPolicy("/whatever", "/tmp/some-policy.yaml");
    expect(overridden.cpu).toBeUndefined();
    expect(overridden.memory).toBeUndefined();
  });

  it("carries credentials from the folder; empty on --policy override", () => {
    const proj = projectWith(
      "mounts: []\ncredentials:\n  - name: github\n    values:\n      GITHUB_TOKEN: { from_env: GITHUB_TOKEN }\n",
    );
    expect(resolveRepoPolicy(proj).credentials).toEqual([
      { name: "github", values: { GITHUB_TOKEN: { from_env: "GITHUB_TOKEN" } } },
    ]);

    const overridden = resolveRepoPolicy("/whatever", "/tmp/some-policy.yaml");
    expect(overridden.credentials).toEqual([]);
  });
});

describe("stageProviderSandboxFiles", () => {
  function freshStaging(): string {
    const tmp = mkdtempSync(join(tmpdir(), "stage-"));
    const staging = join(tmp, ".openlock");
    mkdirSync(staging);
    return staging;
  }

  it("writes a valid file to the prefix-stripped staging-relative location", () => {
    const staging = freshStaging();
    stageProviderSandboxFiles(staging, [
      { sandboxPath: "/sandbox/.openlock/claude-config/.credentials.json", content: "{}" },
    ]);
    const dest = join(staging, "claude-config/.credentials.json");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("{}");
  });

  it("rejects a '..' traversal path so a provider cannot escape the staging dir", () => {
    const staging = freshStaging();
    expect(() =>
      stageProviderSandboxFiles(staging, [
        { sandboxPath: "/sandbox/.openlock/../../etc/passwd", content: "pwned" },
      ]),
    ).toThrow(/must not contain '\.\.'/);
    // Confirm nothing escaped: the traversal target was never written.
    expect(existsSync(join(staging, "..", "..", "etc", "passwd"))).toBe(false);
  });

  it("delegates to stagingPathFor — rejects a path outside the /sandbox/.openlock/ prefix", () => {
    const staging = freshStaging();
    expect(() =>
      stageProviderSandboxFiles(staging, [{ sandboxPath: "/etc/passwd", content: "x" }]),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });
});

describe("userExplicitlyPickedHarness", () => {
  it("returns false when neither cliFlag nor env is set", () => {
    expect(userExplicitlyPickedHarness({ cliFlag: undefined, envOpenlockHarness: undefined })).toBe(
      false,
    );
  });

  it("returns true when cliFlag is set", () => {
    expect(
      userExplicitlyPickedHarness({ cliFlag: "opencode", envOpenlockHarness: undefined }),
    ).toBe(true);
  });

  it("returns true when env OPENLOCK_HARNESS is set", () => {
    expect(
      userExplicitlyPickedHarness({ cliFlag: undefined, envOpenlockHarness: "opencode" }),
    ).toBe(true);
  });

  it("returns true when both are set", () => {
    expect(
      userExplicitlyPickedHarness({ cliFlag: "opencode", envOpenlockHarness: "claude_code" }),
    ).toBe(true);
  });

  it("treats empty strings as not-set (Boolean coercion)", () => {
    expect(userExplicitlyPickedHarness({ cliFlag: "", envOpenlockHarness: "" })).toBe(false);
  });
});

describe("pickSessionHarness", () => {
  it("uses the resolved harness when there is no existing session", () => {
    expect(
      pickSessionHarness({
        existingSessionHarness: null,
        userExplicitFlag: undefined,
        envOpenlockHarness: undefined,
        resolvedHarness: "claude_code",
      }),
    ).toEqual({ harness: "claude_code", mismatch: false });
  });

  it("uses the resolved harness on first-create even when user passes explicit", () => {
    expect(
      pickSessionHarness({
        existingSessionHarness: null,
        userExplicitFlag: "opencode",
        envOpenlockHarness: undefined,
        resolvedHarness: "opencode",
      }),
    ).toEqual({ harness: "opencode", mismatch: false });
  });

  it("prefers existing session harness when user gave no explicit signal (reattach)", () => {
    expect(
      pickSessionHarness({
        existingSessionHarness: "opencode",
        userExplicitFlag: undefined,
        envOpenlockHarness: undefined,
        resolvedHarness: "claude_code",
      }),
    ).toEqual({ harness: "opencode", mismatch: false });
  });

  it("returns mismatch when user passes --harness that conflicts with existing session", () => {
    expect(
      pickSessionHarness({
        existingSessionHarness: "claude_code",
        userExplicitFlag: "opencode",
        envOpenlockHarness: undefined,
        resolvedHarness: "opencode",
      }),
    ).toEqual({ harness: "opencode", mismatch: true });
  });

  it("returns mismatch when env OPENLOCK_HARNESS conflicts with existing session", () => {
    expect(
      pickSessionHarness({
        existingSessionHarness: "claude_code",
        userExplicitFlag: undefined,
        envOpenlockHarness: "opencode",
        resolvedHarness: "opencode",
      }),
    ).toEqual({ harness: "opencode", mismatch: true });
  });

  it("no mismatch when user's explicit signal matches existing session", () => {
    expect(
      pickSessionHarness({
        existingSessionHarness: "opencode",
        userExplicitFlag: "opencode",
        envOpenlockHarness: undefined,
        resolvedHarness: "opencode",
      }),
    ).toEqual({ harness: "opencode", mismatch: false });
  });

  it("does NOT reject when no explicit signal and default differs from existing (regression guard)", () => {
    // Scenario: user has global-config defaultHarness: opencode set, but this
    // particular session was created earlier as claude_code. resolveHarness
    // returns "opencode" via global-config, but because no --harness/env was
    // given, we should silently reattach to the existing claude_code session.
    expect(
      pickSessionHarness({
        existingSessionHarness: "claude_code",
        userExplicitFlag: undefined,
        envOpenlockHarness: undefined,
        resolvedHarness: "opencode",
      }),
    ).toEqual({ harness: "claude_code", mismatch: false });
  });
});

describe("attachedCredentialBundleNames (openlock-04t)", () => {
  const bundle = (name: string): CredentialBundle => ({
    name,
    values: { TOKEN: { from_env: "TOKEN" } },
  });

  it("maps declared bundles to their names, in order", () => {
    expect(attachedCredentialBundleNames([bundle("github"), bundle("npm")])).toEqual([
      "github",
      "npm",
    ]);
  });

  it("returns an empty array (not undefined) when no bundles are declared", () => {
    expect(attachedCredentialBundleNames([])).toEqual([]);
  });
});

describe("warnOnUnattachedCredentialBundles (openlock-04t)", () => {
  const bundle = (name: string): CredentialBundle => ({
    name,
    values: { TOKEN: { from_env: "TOKEN" } },
  });

  function captureWarn(fn: () => void): string[] {
    const calls: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return calls;
  }

  it("warns when a declared bundle was never attached at create time", () => {
    const calls = captureWarn(() =>
      warnOnUnattachedCredentialBundles("my-sess", [bundle("github")], []),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("github");
    expect(calls[0]).toContain('sandbox "my-sess"');
    expect(calls[0]).toContain("openlock clean my-sess");
    expect(calls[0]).toContain("CREATE time");
  });

  it("stays silent when the declared set matches the recorded set", () => {
    const calls = captureWarn(() =>
      warnOnUnattachedCredentialBundles("my-sess", [bundle("github")], ["github"]),
    );
    expect(calls).toHaveLength(0);
  });

  // The migration-safety case: must NOT warn on a legacy session (recorded
  // set absent) even though every declared bundle technically isn't "in" an
  // absent set — a spurious warning on the very first reattach after this
  // feature ships would be worse than the doc caveat it replaces.
  it("stays silent on a legacy session (recordedAttached undefined), even with declared bundles", () => {
    const calls = captureWarn(() =>
      warnOnUnattachedCredentialBundles("legacy-sess", [bundle("github")], undefined),
    );
    expect(calls).toHaveLength(0);
  });

  it("pluralizes correctly for multiple unattached bundles", () => {
    const calls = captureWarn(() =>
      warnOnUnattachedCredentialBundles("my-sess", [bundle("github"), bundle("npm")], []),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("bundles github, npm are declared");
    expect(calls[0]).toContain("were never attached");
  });
});

// openlock-tgfk wiring guard: the bug in the original ticket was a missing
// CALL SITE (debugEgress/branch were parsed and accepted but never checked
// against anything on a plain reattach), not a missing string builder — the
// pure functions in drift.ts were already unit-testable in isolation before
// this guard existed, and none of those tests would fail if the call site
// wiring them into attachStale were deleted. This test reads session.ts's
// own source and asserts the ACTUAL CALL EXPRESSIONS appear inside
// attachStale specifically — a bare `toContain("debugEgressReattachWarning")`
// would already be satisfied by the import statement at the top of the file
// and would pass even with the call site removed, which is exactly the kind
// of permanently-green check this project has shipped before (a check whose
// filter doesn't match reality). Scoping to the extracted attachStale body
// (rather than the whole file) also guards against the call appearing
// somewhere irrelevant.
describe("attachStale wires the tgfk reattach warnings (openlock-tgfk)", () => {
  const SESSION_TS_PATH = join(import.meta.dir, "session.ts");
  const source = readFileSync(SESSION_TS_PATH, "utf-8");

  // Relies on session.ts's current formatting (one arrow-function const per
  // line, closing `};` on its own line) — same fragility the project already
  // accepts for cli.ts's switch-case parser in _commands.test.ts; a reformat
  // that breaks this would fail this test loudly (ENOENT-style thrown error)
  // rather than silently passing on the wrong slice.
  function extractAttachStaleBody(src: string): string {
    const startMarker = "const attachStale = async () => {";
    const start = src.indexOf(startMarker);
    if (start === -1) {
      throw new Error("attachStale not found in session.ts — was it renamed or removed?");
    }
    const end = src.indexOf("\n  };", start);
    if (end === -1) {
      throw new Error("attachStale's closing '};' not found in session.ts");
    }
    return src.slice(start, end);
  }

  const body = extractAttachStaleBody(source);

  it("calls debugEgressReattachWarning with the recorded ground truth (m.debugEgress)", () => {
    expect(body).toContain("debugEgressReattachWarning(m.name, debugEgress, m.debugEgress)");
  });

  it("calls branchReattachWarning with the recorded ground truth (m.branch)", () => {
    expect(body).toContain("branchReattachWarning(m.name, branch, m.branch)");
  });

  it("actually surfaces a non-null result (prints immediately AND queues it for reprint), not call-and-discard", () => {
    expect(body).toContain("console.warn(line)");
    expect(body).toContain("policyWarningLines.push(line)");
  });
});
