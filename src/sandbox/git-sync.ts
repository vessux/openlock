interface PodmanExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PodmanExec = (containerName: string, args: string[]) => Promise<PodmanExecResult>;

// The default runner runs as the `sandbox` user with cwd `/sandbox/repo`
// to match how claude/openshell touch the sandbox repo. Running as root
// trips git's safe.directory check ("dubious ownership") and the helper
// would mis-report HEAD as detached.
const defaultPodmanExec: PodmanExec = async (containerName, args) => {
  const proc = Bun.spawn(
    ["podman", "exec", "-u", "sandbox", "-w", "/sandbox/repo", containerName, ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export async function readSandboxActiveBranch(
  containerName: string,
  exec: PodmanExec = defaultPodmanExec,
): Promise<string | null> {
  const { exitCode, stdout } = await exec(containerName, ["git", "symbolic-ref", "-q", "HEAD"]);
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  const prefix = "refs/heads/";
  if (!trimmed.startsWith(prefix)) return null;
  return trimmed.slice(prefix.length);
}

async function spawn(cmd: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
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

export interface PromoteOptions {
  force?: boolean;
  targetName?: string;
}

export interface PromoteResult {
  outcome: "created" | "fast-forwarded" | "skipped" | "diverged";
  target: string;
  oid: string;
}

async function captureStdout(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

async function resolveOid(repoDir: string, ref: string): Promise<string | null> {
  const { exitCode, stdout } = await captureStdout(
    ["git", "rev-parse", "--verify", `${ref}^{commit}`],
    repoDir,
  );
  if (exitCode !== 0) return null;
  return stdout.trim() || null;
}

async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return code === 0;
}

export async function promoteActiveBranch(
  repoDir: string,
  sessionName: string,
  activeBranch: string | null,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  // Treat empty string the same as undefined to avoid producing
  // refs/heads/ (no leaf) when callers pass `-b ""` from the CLI.
  const targetName =
    opts.targetName === undefined || opts.targetName === ""
      ? `openlock/${sessionName}`
      : opts.targetName;
  const target = `refs/heads/${targetName}`;
  if (activeBranch === null) {
    return { outcome: "skipped", target, oid: "" };
  }
  const sourceRef = `refs/sandbox/${sessionName}/${activeBranch}`;
  const newOid = await resolveOid(repoDir, sourceRef);
  if (newOid === null) {
    return { outcome: "skipped", target, oid: "" };
  }
  const oldOid = await resolveOid(repoDir, target);
  if (oldOid === null) {
    const { exitCode, stderr } = await spawn(
      ["git", "update-ref", "--create-reflog", target, newOid],
      repoDir,
    );
    if (exitCode !== 0) {
      throw new Error(`update-ref ${target} failed: ${stderr}`);
    }
    return { outcome: "created", target, oid: newOid };
  }
  if (oldOid === newOid) {
    return { outcome: "skipped", target, oid: newOid };
  }
  const ff = await isAncestor(repoDir, oldOid, newOid);
  if (ff) {
    const { exitCode, stderr } = await spawn(
      ["git", "update-ref", "--create-reflog", target, newOid, oldOid],
      repoDir,
    );
    if (exitCode !== 0) {
      throw new Error(`update-ref ${target} failed: ${stderr}`);
    }
    return { outcome: "fast-forwarded", target, oid: newOid };
  }
  if (opts.force === true) {
    const { exitCode, stderr } = await spawn(
      ["git", "update-ref", "--create-reflog", target, newOid],
      repoDir,
    );
    if (exitCode !== 0) {
      throw new Error(`update-ref ${target} failed: ${stderr}`);
    }
    return { outcome: "created", target, oid: newOid };
  }
  return { outcome: "diverged", target, oid: newOid };
}

export function formatSyncBackLog(
  sessionName: string,
  activeBranch: string | null,
  promote: PromoteResult,
): string {
  const targetShort = promote.target.replace("refs/heads/", "");
  switch (promote.outcome) {
    case "created":
      return `Sandbox commits synced to refs/sandbox/${sessionName}/*. Promoted to ${targetShort}.`;
    case "fast-forwarded":
      return `Sandbox commits synced. Fast-forwarded ${targetShort}.`;
    case "diverged":
      return `Sandbox commits synced. ${targetShort} has diverged from sandbox; refs preserved at refs/sandbox/${sessionName}/. Use 'openlock refs promote ${sessionName} --force' to overwrite.`;
    case "skipped":
      if (activeBranch === null) {
        return `Sandbox commits synced to refs/sandbox/${sessionName}/*. HEAD was detached; no auto-promote. Use 'openlock refs promote ${sessionName} <branch>' to pick.`;
      }
      return `Sandbox commits synced to refs/sandbox/${sessionName}/*.`;
  }
}
