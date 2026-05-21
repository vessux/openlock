import { describe, expect, it } from "bun:test";
import { validateBranchFlagAgainstWorkdir } from "./branch-validation";

describe("validateBranchFlagAgainstWorkdir", () => {
  it("returns null when --branch is absent and no workdir mount", () => {
    expect(validateBranchFlagAgainstWorkdir(undefined, undefined)).toBeNull();
  });

  it("returns null when --branch is absent and workdir is git-bundle", () => {
    expect(
      validateBranchFlagAgainstWorkdir(undefined, {
        source: "/h",
        target: "/sandbox/repo",
        type: "git-bundle",
      }),
    ).toBeNull();
  });

  it("returns null when --branch is present and workdir is git-bundle", () => {
    expect(
      validateBranchFlagAgainstWorkdir("feature/x", {
        source: "/h",
        target: "/sandbox/repo",
        type: "git-bundle",
      }),
    ).toBeNull();
  });

  it("returns error when --branch present and workdir is bind", () => {
    const err = validateBranchFlagAgainstWorkdir("feature/x", {
      source: "/h",
      target: "/sandbox/repo",
      type: "bind",
    });
    expect(err).toMatch(/--branch is only valid with git-bundle workdir/);
    expect(err).toMatch(/type: bind/);
  });

  it("returns error when --branch present and no workdir mount declared", () => {
    const err = validateBranchFlagAgainstWorkdir("feature/x", undefined);
    expect(err).toMatch(/--branch requires a git-bundle workdir/);
    expect(err).toMatch(/no workdir mount declared/);
  });

  it("returns error when --branch contains a single-quote character", () => {
    const err = validateBranchFlagAgainstWorkdir("foo'; rm -rf /", {
      source: "/h",
      target: "/sandbox/repo",
      type: "git-bundle",
    });
    expect(err).toMatch(/--branch must not contain single-quote characters/);
  });
});
