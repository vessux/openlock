import { existsSync } from "fs";
import { join } from "path";

async function spawn(cmd: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

export async function ensureGitRepo(dir: string): Promise<void> {
  if (existsSync(join(dir, ".git"))) return;
  await spawn(["git", "init"], dir);
  await spawn(["git", "commit", "--allow-empty", "-m", "initial commit"], dir);
}

export async function createBundle(repoDir: string, bundlePath: string): Promise<void> {
  const { exitCode, stderr } = await spawn(
    ["git", "bundle", "create", bundlePath, "--all"],
    repoDir,
  );
  if (exitCode !== 0) {
    throw new Error(`git bundle create failed: ${stderr}`);
  }
}

export async function fetchBundle(repoDir: string, bundlePath: string): Promise<void> {
  const { exitCode, stderr } = await spawn(
    ["git", "fetch", bundlePath, "refs/*:refs/remotes/sandbox/*"],
    repoDir,
  );
  if (exitCode !== 0) {
    throw new Error(`git fetch from bundle failed: ${stderr}`);
  }
}
