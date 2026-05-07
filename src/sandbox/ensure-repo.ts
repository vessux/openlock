import { existsSync, mkdirSync } from "fs";
import { join } from "path";

export type EnsureRepoAction = "existed" | "created" | "inited" | "ensured-commit";

export interface EnsureRepoResult {
  action: EnsureRepoAction;
}

async function spawn(cmd: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(p.stderr).text();
  const exitCode = await p.exited;
  return { exitCode, stderr };
}

async function hasCommits(dir: string): Promise<boolean> {
  const { exitCode } = await spawn(["git", "log", "--oneline", "-1"], dir);
  return exitCode === 0;
}

async function gitInit(dir: string): Promise<void> {
  const { exitCode, stderr } = await spawn(["git", "init"], dir);
  if (exitCode !== 0) throw new Error(`git init failed in ${dir}: ${stderr}`);
}

async function landEmptyCommit(dir: string): Promise<void> {
  const { exitCode, stderr } = await spawn(
    ["git", "commit", "--allow-empty", "-m", "initial commit"],
    dir,
  );
  if (exitCode !== 0) throw new Error(`git commit failed in ${dir}: ${stderr}`);
}

export async function ensureRepoIsGit(path: string): Promise<EnsureRepoResult> {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    await gitInit(path);
    await landEmptyCommit(path);
    return { action: "created" };
  }
  if (!existsSync(join(path, ".git"))) {
    await gitInit(path);
    await landEmptyCommit(path);
    return { action: "inited" };
  }
  if (!(await hasCommits(path))) {
    await landEmptyCommit(path);
    return { action: "ensured-commit" };
  }
  return { action: "existed" };
}
