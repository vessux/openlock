import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureRepoIsGit } from "./ensure-repo";

async function spawn(cmd: string[], cwd: string): Promise<number> {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  return await p.exited;
}

describe("ensureRepoIsGit", () => {
  it("creates the directory when missing (action: created)", async () => {
    const root = mkdtempSync(join(tmpdir(), "openlock-ensure-repo-"));
    try {
      const target = join(root, "new-project");
      const result = await ensureRepoIsGit(target);
      expect(result.action).toBe("created");
      expect(existsSync(target)).toBe(true);
      expect(existsSync(join(target, ".git"))).toBe(true);
      const log = await spawn(["git", "log", "--oneline", "-1"], target);
      expect(log).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inits when dir exists but is not a git repo (action: inited)", async () => {
    const root = mkdtempSync(join(tmpdir(), "openlock-ensure-repo-"));
    try {
      const result = await ensureRepoIsGit(root);
      expect(result.action).toBe("inited");
      expect(existsSync(join(root, ".git"))).toBe(true);
      const log = await spawn(["git", "log", "--oneline", "-1"], root);
      expect(log).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lands an empty commit when git repo has zero commits (action: ensured-commit)", async () => {
    const root = mkdtempSync(join(tmpdir(), "openlock-ensure-repo-"));
    try {
      await spawn(["git", "init"], root);
      const before = await spawn(["git", "log", "--oneline", "-1"], root);
      expect(before).not.toBe(0);
      const result = await ensureRepoIsGit(root);
      expect(result.action).toBe("ensured-commit");
      const after = await spawn(["git", "log", "--oneline", "-1"], root);
      expect(after).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op for an existing git repo with commits (action: existed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "openlock-ensure-repo-"));
    try {
      await spawn(["git", "init"], root);
      await spawn(["git", "commit", "--allow-empty", "-m", "seed"], root);
      const result = await ensureRepoIsGit(root);
      expect(result.action).toBe("existed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
