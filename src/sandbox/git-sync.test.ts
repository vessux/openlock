import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createBundle, ensureGitRepo } from "./git-sync";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const testDir = join(import.meta.dir, "../../.test-git-sync");

// Hermetic git identity for hosts (e.g. fresh Linux CI) where no global
// user.name/user.email is configured — without it `git commit` silently
// produces no commit and the bundle ends up empty.
async function run(cmd: string[], cwd: string): Promise<void> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore", env });
  await proc.exited;
}

describe("git-sync", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("ensureGitRepo", () => {
    it("initializes git repo in bare directory", async () => {
      const dir = join(testDir, "bare");
      mkdirSync(dir);
      await ensureGitRepo(dir);
      expect(existsSync(join(dir, ".git"))).toBe(true);
    });

    it("is a no-op for existing git repo", async () => {
      const dir = join(testDir, "existing");
      mkdirSync(dir);
      await run(["git", "init"], dir);
      await run(["git", "commit", "--allow-empty", "-m", "init"], dir);
      await ensureGitRepo(dir);
      expect(existsSync(join(dir, ".git"))).toBe(true);
    });
  });

  describe("createBundle", () => {
    it("creates a bundle file from a git repo", async () => {
      const dir = join(testDir, "repo");
      mkdirSync(dir);
      await run(["git", "init"], dir);
      await run(["git", "commit", "--allow-empty", "-m", "init"], dir);
      const bundlePath = join(testDir, "test.bundle");
      await createBundle(dir, bundlePath);
      expect(existsSync(bundlePath)).toBe(true);
    });
  });
});
