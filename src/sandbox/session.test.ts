import { describe, expect, it } from "bun:test";
import { pickSessionHarness, userExplicitlyPickedHarness } from "./session";

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
