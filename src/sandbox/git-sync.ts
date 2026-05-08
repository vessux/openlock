import { existsSync } from "node:fs";
import { join } from "node:path";

async function spawn(cmd: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

export async function ensureGitRepo(dir: string): Promise<void> {
  if (existsSync(join(dir, ".git"))) return;
  await spawn(["git", "init"], dir);
  // Inline identity so we never depend on host git config; matches
  // the same fix in ensure-repo.ts (landEmptyCommit).
  await spawn(
    [
      "git",
      "-c",
      "user.email=openlock@local",
      "-c",
      "user.name=openlock",
      "commit",
      "--allow-empty",
      "-m",
      "initial commit",
    ],
    dir,
  );
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

export async function fetchBundle(
  repoDir: string,
  bundlePath: string,
  sessionName: string,
): Promise<void> {
  const refspec = `refs/heads/*:refs/sandbox/${sessionName}/*`;
  const { exitCode, stderr } = await spawn(["git", "fetch", bundlePath, refspec], repoDir);
  if (exitCode !== 0) {
    throw new Error(`git fetch from bundle failed: ${stderr}`);
  }
}

export async function pruneSandboxRefs(repoDir: string, sessionName: string): Promise<void> {
  const list = Bun.spawn(
    ["git", "for-each-ref", "--format=%(refname)", `refs/sandbox/${sessionName}/`],
    { cwd: repoDir, stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(list.stdout).text();
  await list.exited;
  const refs = out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const ref of refs) {
    const del = Bun.spawn(["git", "update-ref", "-d", ref], {
      cwd: repoDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    await del.exited;
  }
}
