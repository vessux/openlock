import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGitIdentity } from "./git-identity";

describe("prepareGitIdentity", () => {
  let tmpRoot: string;
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    // mkdtempSync gives an unpredictable suffix, avoiding the race-on-fixed-path
    // pattern that CodeQL flags as "insecure temporary file".
    tmpRoot = mkdtempSync(join(tmpdir(), "openlock-git-identity-"));
    tmpDir = join(tmpRoot, "out");
    fakeHome = join(tmpRoot, "home");
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when no git identity is configured", async () => {
    writeFileSync(join(fakeHome, ".gitconfig"), "");
    const result = await prepareGitIdentity(tmpDir, { homeOverride: fakeHome });
    expect(result).toBeNull();
  });

  it("returns gitconfig path when host identity is set", async () => {
    writeFileSync(
      join(fakeHome, ".gitconfig"),
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
    );
    const result = await prepareGitIdentity(tmpDir, { homeOverride: fakeHome });
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
    const contents = readFileSync(result!, "utf-8");
    expect(contents).toContain("name = Test User");
    expect(contents).toContain("email = test@example.com");
  });

  it("returns null when only name is set (incomplete identity)", async () => {
    writeFileSync(join(fakeHome, ".gitconfig"), "[user]\n\tname = Test User\n");
    const result = await prepareGitIdentity(tmpDir, { homeOverride: fakeHome });
    expect(result).toBeNull();
  });
});
