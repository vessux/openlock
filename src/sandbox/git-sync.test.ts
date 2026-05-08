import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureRepoIsGit } from "./ensure-repo";
import { createBundle, fetchBundle, pruneSandboxRefs } from "./git-sync";

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

  describe("git-sync namespaced", () => {
    it("fetchBundle writes to refs/sandbox/<sessionName>/*", async () => {
      const hostDir = join(testDir, "host");
      const workDir = join(testDir, "work");
      mkdirSync(hostDir);
      mkdirSync(workDir);
      await ensureRepoIsGit(hostDir);
      await ensureRepoIsGit(workDir);
      await run(["git", "checkout", "-b", "feature"], workDir);
      await run(["git", "commit", "--allow-empty", "-m", "feature work"], workDir);
      const bundle = join(testDir, "out.bundle");
      await createBundle(workDir, bundle);

      await fetchBundle(hostDir, bundle, "openlock-abc123");

      const p = Bun.spawn(["git", "for-each-ref", "--format=%(refname)"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const refs = await new Response(p.stdout).text();
      await p.exited;
      expect(refs).toContain("refs/sandbox/openlock-abc123/feature");
    });

    it("pruneSandboxRefs deletes refs/sandbox/<sessionName>/* and leaves others", async () => {
      const hostDir = join(testDir, "host-prune");
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      await run(["git", "update-ref", "refs/sandbox/sess-a/main", "HEAD"], hostDir);
      await run(["git", "update-ref", "refs/sandbox/sess-b/main", "HEAD"], hostDir);

      await pruneSandboxRefs(hostDir, "sess-a");

      const p = Bun.spawn(["git", "for-each-ref", "--format=%(refname)"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const refs = await new Response(p.stdout).text();
      await p.exited;
      expect(refs).not.toContain("refs/sandbox/sess-a/main");
      expect(refs).toContain("refs/sandbox/sess-b/main");
    });

    it("pruneSandboxRefs no-ops when session has no refs", async () => {
      const hostDir = join(testDir, "host-ghost");
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      await pruneSandboxRefs(hostDir, "ghost");
    });
  });
});
