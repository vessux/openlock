import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareGitIdentity } from "./git-identity";

const tmpRoot = join(tmpdir(), "openlock-git-identity-test");

describe("prepareGitIdentity", () => {
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
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
    writeFileSync(
      join(fakeHome, ".gitconfig"),
      "[user]\n\tname = Test User\n",
    );
    const result = await prepareGitIdentity(tmpDir, { homeOverride: fakeHome });
    expect(result).toBeNull();
  });
});
