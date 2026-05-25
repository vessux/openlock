import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureRepoIsGit } from "./ensure-repo";
import {
  createBundle,
  fetchBundle,
  formatSyncBackLog,
  promoteActiveBranch,
  pruneSandboxRefs,
  readSandboxActiveBranch,
  type SandboxExec,
} from "./git-sync";

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

  describe("readSandboxActiveBranch", () => {
    it("returns branch name when HEAD is on a branch", async () => {
      const exec: SandboxExec = async (_container, _args) => ({
        exitCode: 0,
        stdout: "refs/heads/feature/x\n",
        stderr: "",
      });
      const result = await readSandboxActiveBranch("any-container", "/sandbox/repo", exec);
      expect(result).toBe("feature/x");
    });

    it("returns null when HEAD is detached (exit 1)", async () => {
      const exec: SandboxExec = async () => ({ exitCode: 1, stdout: "", stderr: "" });
      const result = await readSandboxActiveBranch("any-container", "/sandbox/repo", exec);
      expect(result).toBeNull();
    });

    it("returns null when output has no refs/heads/ prefix (defensive)", async () => {
      const exec: SandboxExec = async () => ({ exitCode: 0, stdout: "garbage\n", stderr: "" });
      const result = await readSandboxActiveBranch("any-container", "/sandbox/repo", exec);
      expect(result).toBeNull();
    });

    it("invokes exec with correct args", async () => {
      let capturedContainer = "";
      let capturedArgs: string[] = [];
      const exec: SandboxExec = async (container, args) => {
        capturedContainer = container;
        capturedArgs = args;
        return { exitCode: 0, stdout: "refs/heads/main\n", stderr: "" };
      };
      await readSandboxActiveBranch("openlock-foo", "/sandbox/repo", exec);
      expect(capturedContainer).toBe("openlock-foo");
      expect(capturedArgs).toEqual(["git", "symbolic-ref", "-q", "HEAD"]);
    });
  });

  describe("promoteActiveBranch", () => {
    async function setupHostWithSandboxRef(
      hostDir: string,
      sessionName: string,
      branchName: string,
    ): Promise<string> {
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "initial"], hostDir);
      await run(
        ["git", "update-ref", `refs/sandbox/${sessionName}/${branchName}`, "HEAD"],
        hostDir,
      );
      const p = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const oid = (await new Response(p.stdout).text()).trim();
      await p.exited;
      return oid;
    }

    it("creates target branch when absent", async () => {
      const hostDir = join(testDir, "p1-host");
      const oid = await setupHostWithSandboxRef(hostDir, "sess1", "main");
      const result = await promoteActiveBranch(hostDir, "sess1", "main");
      expect(result.outcome).toBe("created");
      expect(result.target).toBe("refs/heads/openlock/sess1");
      expect(result.oid).toBe(oid);

      const p = Bun.spawn(["git", "rev-parse", "refs/heads/openlock/sess1"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const writtenOid = (await new Response(p.stdout).text()).trim();
      await p.exited;
      expect(writtenOid).toBe(oid);
    });

    it("returns 'skipped' when activeBranch is null", async () => {
      const hostDir = join(testDir, "p2-host");
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      const result = await promoteActiveBranch(hostDir, "sess2", null);
      expect(result.outcome).toBe("skipped");
    });

    it("returns 'skipped' when sandbox source ref does not exist", async () => {
      const hostDir = join(testDir, "p3-host");
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      const result = await promoteActiveBranch(hostDir, "sess3", "main");
      expect(result.outcome).toBe("skipped");
    });

    it("returns 'skipped' when source OID equals existing target OID", async () => {
      const hostDir = join(testDir, "p4-host");
      const oid = await setupHostWithSandboxRef(hostDir, "sess4", "main");
      // Pre-create target at same OID.
      await run(["git", "update-ref", "refs/heads/openlock/sess4", oid], hostDir);
      const result = await promoteActiveBranch(hostDir, "sess4", "main");
      expect(result.outcome).toBe("skipped");
      expect(result.oid).toBe(oid);
    });

    it("fast-forwards target when source is descendant", async () => {
      const hostDir = join(testDir, "p5-host");
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "old"], hostDir);
      const oldP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const oldOid = (await new Response(oldP.stdout).text()).trim();
      await oldP.exited;
      await run(["git", "update-ref", "refs/heads/openlock/sess5", oldOid], hostDir);
      // Advance HEAD with a new commit; place sandbox ref at new HEAD.
      await run(["git", "commit", "--allow-empty", "-m", "new"], hostDir);
      const newP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const newOid = (await new Response(newP.stdout).text()).trim();
      await newP.exited;
      await run(["git", "update-ref", "refs/sandbox/sess5/master", newOid], hostDir);

      const result = await promoteActiveBranch(hostDir, "sess5", "master");
      expect(result.outcome).toBe("fast-forwarded");
      expect(result.oid).toBe(newOid);
    });

    it("returns 'diverged' when target exists and is not ancestor (no force)", async () => {
      const hostDir = join(testDir, "p6-host");
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "common"], hostDir);
      // Capture the common OID so we can branch off it without depending on
      // the host's init.defaultBranch (master vs main).
      const commonP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const commonOid = (await new Response(commonP.stdout).text()).trim();
      await commonP.exited;
      // Branch A at common.
      await run(["git", "checkout", "-b", "branchA"], hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "A1"], hostDir);
      const aP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const aOid = (await new Response(aP.stdout).text()).trim();
      await aP.exited;
      // Branch B at common (sandbox-side).
      await run(["git", "checkout", commonOid], hostDir);
      await run(["git", "checkout", "-b", "branchB"], hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "B1"], hostDir);
      const bP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const bOid = (await new Response(bP.stdout).text()).trim();
      await bP.exited;
      // Set up: target at A, sandbox source at B (diverged).
      await run(["git", "update-ref", "refs/heads/openlock/sess6", aOid], hostDir);
      await run(["git", "update-ref", "refs/sandbox/sess6/master", bOid], hostDir);

      const result = await promoteActiveBranch(hostDir, "sess6", "master");
      expect(result.outcome).toBe("diverged");
      expect(result.oid).toBe(bOid);

      // Target unchanged.
      const finalP = Bun.spawn(["git", "rev-parse", "refs/heads/openlock/sess6"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const finalOid = (await new Response(finalP.stdout).text()).trim();
      await finalP.exited;
      expect(finalOid).toBe(aOid);
    });

    it("force=true overwrites diverged target", async () => {
      const hostDir = join(testDir, "p7-host");
      mkdirSync(hostDir);
      await ensureRepoIsGit(hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "common"], hostDir);
      const commonP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const commonOid = (await new Response(commonP.stdout).text()).trim();
      await commonP.exited;
      await run(["git", "checkout", "-b", "branchA"], hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "A1"], hostDir);
      const aP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const aOid = (await new Response(aP.stdout).text()).trim();
      await aP.exited;
      await run(["git", "checkout", commonOid], hostDir);
      await run(["git", "checkout", "-b", "branchB"], hostDir);
      await run(["git", "commit", "--allow-empty", "-m", "B1"], hostDir);
      const bP = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const bOid = (await new Response(bP.stdout).text()).trim();
      await bP.exited;
      await run(["git", "update-ref", "refs/heads/openlock/sess7", aOid], hostDir);
      await run(["git", "update-ref", "refs/sandbox/sess7/master", bOid], hostDir);

      const result = await promoteActiveBranch(hostDir, "sess7", "master", { force: true });
      expect(result.outcome).toBe("created");
      expect(result.oid).toBe(bOid);

      const finalP = Bun.spawn(["git", "rev-parse", "refs/heads/openlock/sess7"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const finalOid = (await new Response(finalP.stdout).text()).trim();
      await finalP.exited;
      expect(finalOid).toBe(bOid);
    });

    it("uses custom targetName when provided", async () => {
      const hostDir = join(testDir, "p8-host");
      const oid = await setupHostWithSandboxRef(hostDir, "sess8", "main");
      const result = await promoteActiveBranch(hostDir, "sess8", "main", {
        targetName: "review/sess8-result",
      });
      expect(result.outcome).toBe("created");
      expect(result.target).toBe("refs/heads/review/sess8-result");
      const p = Bun.spawn(["git", "rev-parse", "refs/heads/review/sess8-result"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const writtenOid = (await new Response(p.stdout).text()).trim();
      await p.exited;
      expect(writtenOid).toBe(oid);
    });

    it("treats empty targetName as default", async () => {
      const hostDir = join(testDir, "p9-host");
      const oid = await setupHostWithSandboxRef(hostDir, "sess9", "main");
      const result = await promoteActiveBranch(hostDir, "sess9", "main", {
        targetName: "",
      });
      expect(result.outcome).toBe("created");
      expect(result.target).toBe("refs/heads/openlock/sess9");
      const p = Bun.spawn(["git", "rev-parse", "refs/heads/openlock/sess9"], {
        cwd: hostDir,
        stdout: "pipe",
        stderr: "ignore",
      });
      const writtenOid = (await new Response(p.stdout).text()).trim();
      await p.exited;
      expect(writtenOid).toBe(oid);
    });
  });

  describe("formatSyncBackLog", () => {
    it("created → promoted line with default target", () => {
      const line = formatSyncBackLog("sess1", "main", {
        outcome: "created",
        target: "refs/heads/openlock/sess1",
        oid: "abc123",
      });
      expect(line).toBe(
        "Sandbox commits synced to refs/sandbox/sess1/*. Promoted to openlock/sess1.",
      );
    });

    it("fast-forwarded → ff line with target stripped of refs/heads/", () => {
      const line = formatSyncBackLog("sess2", "main", {
        outcome: "fast-forwarded",
        target: "refs/heads/openlock/sess2",
        oid: "def456",
      });
      expect(line).toBe("Sandbox commits synced. Fast-forwarded openlock/sess2.");
    });

    it("diverged → recovery line points at refs/sandbox + --force hint", () => {
      const line = formatSyncBackLog("sess3", "main", {
        outcome: "diverged",
        target: "refs/heads/openlock/sess3",
        oid: "ghi789",
      });
      expect(line).toContain("openlock/sess3 has diverged");
      expect(line).toContain("refs/sandbox/sess3/");
      expect(line).toContain("openlock refs promote sess3 --force");
    });

    it("skipped + activeBranch null → detached-HEAD recovery hint", () => {
      const line = formatSyncBackLog("sess4", null, {
        outcome: "skipped",
        target: "refs/heads/openlock/sess4",
        oid: "",
      });
      expect(line).toContain("HEAD was detached");
      expect(line).toContain("openlock refs promote sess4 <branch>");
    });

    it("skipped + activeBranch present → plain synced line", () => {
      const line = formatSyncBackLog("sess5", "main", {
        outcome: "skipped",
        target: "refs/heads/openlock/sess5",
        oid: "",
      });
      expect(line).toBe("Sandbox commits synced to refs/sandbox/sess5/*.");
    });
  });
});
