import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickSessionHarness,
  resolveRepoPolicy,
  stageProviderSandboxFiles,
  userExplicitlyPickedHarness,
} from "./session";

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
