import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepoIsGit } from "./ensure-repo";

// Hermetic env: hide host git config so tests fail loudly if prod code
// depends on it (caught the v0.2.0 "Author identity unknown" bug).
const ORIG_ENV: Record<string, string | undefined> = {};
const HERMETIC_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];
let hermeticHome: string | null = null;

beforeEach(() => {
  for (const k of HERMETIC_KEYS) ORIG_ENV[k] = process.env[k];
  hermeticHome = mkdtempSync(join(tmpdir(), "openlock-ensure-repo-home-"));
  process.env.HOME = hermeticHome;
  process.env.GIT_CONFIG_GLOBAL = join(hermeticHome, ".gitconfig"); // missing → no global config
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
});

afterEach(() => {
  for (const k of HERMETIC_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
  if (hermeticHome) rmSync(hermeticHome, { recursive: true, force: true });
  hermeticHome = null;
});

async function spawn(cmd: string[], cwd: string): Promise<number> {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  return await p.exited;
}

async function gitInitInDir(dir: string): Promise<void> {
  await spawn(["git", "init"], dir);
}

async function gitCommitSeed(dir: string): Promise<void> {
  await spawn(
    [
      "git",
      "-c",
      "user.email=test@local",
      "-c",
      "user.name=test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ],
    dir,
  );
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
      await gitInitInDir(root);
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
      await gitInitInDir(root);
      await gitCommitSeed(root);
      const result = await ensureRepoIsGit(root);
      expect(result.action).toBe("existed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
