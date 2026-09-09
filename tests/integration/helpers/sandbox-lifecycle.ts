// Shared live-integration helpers for the fork v0.9.0 (upstream v0.0.116,
// #2726 "canonical main process") sandbox create/upload/exec contract:
//   - the trailing `-- <COMMAND>` on `sandbox create` is now the sandbox's
//     supervised main process, so tests that want to run a *foreground*
//     probe command must create with a long-lived main process (`sleep
//     infinity`, matching the product's own `buildOpenshellCreateArgv`) and
//     run the probe afterwards via `sandbox exec`;
//   - `--upload` is rejected alongside a trailing command, so uploading
//     staging content is a separate `sandbox upload` call, done after the
//     sandbox is Ready;
//   - non-interactive persistent creates detach implicitly; `--detach` makes
//     that explicit and means `sandbox create` returns once the sandbox
//     exists (not once the main process exits) — no child process to track
//     or reap afterward, unlike the pre-#2726 world where `create -- <cmd>`
//     stayed attached for the sandbox's lifetime.
//
// Mirrors src/sandbox/container.ts's buildOpenshellCreateArgv /
// buildOpenshellUploadArgv so live-integration tests exercise the same argv
// shapes the product emits.

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function spawnAndCapture(argv: string[], cwd?: string): Promise<SpawnResult> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export interface DetachedCreateOpts {
  name: string;
  image: string;
  policy: string;
  providers: string[];
  /** Extra argv tokens inserted before `--no-tty --detach -- sleep infinity`
   * (e.g. `--log-level debug`). */
  extra?: string[];
}

/** `sandbox create --name … --from … --policy … [--provider …]* --no-tty
 * --detach -- sleep infinity` — the main process is a placeholder long-lived
 * sleep, matching the product's own detached-create shape; the real probe
 * command runs afterward via `execInSandbox`. */
export function buildDetachedCreateArgv(
  argvHead: readonly string[],
  opts: DetachedCreateOpts,
): string[] {
  return [
    ...argvHead,
    "sandbox",
    "create",
    "--name",
    opts.name,
    "--from",
    opts.image,
    "--policy",
    opts.policy,
    ...opts.providers.flatMap((p) => ["--provider", p]),
    ...(opts.extra ?? []),
    "--no-tty",
    "--detach",
    "--",
    "sleep",
    "infinity",
  ];
}

/** Waits for `sandbox exec … -- /bin/true` to succeed — the gateway rejects
 * exec with "not ready" until the supervisor finishes provisioning. */
export async function waitForSandboxReady(
  argvHead: readonly string[],
  cwd: string | undefined,
  name: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await spawnAndCapture(
      [...argvHead, "sandbox", "exec", "--name", name, "--no-tty", "--", "/bin/true"],
      cwd,
    );
    if (r.code === 0) return;
    await Bun.sleep(500);
  }
  throw new Error(`sandbox ${name} did not reach Ready state within ${timeoutMs}ms`);
}

/** Runs `buildDetachedCreateArgv`, throws (with stderr) on a non-zero exit —
 * unlike the pre-#2726 tests, which spawned create with a trailing command
 * and never checked its exit code, silently masking the clap rejection this
 * helper exists to avoid repeating — then polls until the sandbox is Ready. */
export async function createDetachedSandbox(
  argvHead: readonly string[],
  opts: DetachedCreateOpts,
  cwd?: string,
): Promise<void> {
  const argv = buildDetachedCreateArgv(argvHead, opts);
  const result = await spawnAndCapture(argv, cwd);
  if (result.code !== 0) {
    throw new Error(`sandbox create ${opts.name} failed (exit ${result.code}): ${result.stderr}`);
  }
  await waitForSandboxReady(argvHead, cwd, opts.name);
}

/** `sandbox upload <name> <local> <dest> --no-git-ignore` — same helper (and
 * subdir-of-dest semantics) as the removed `--upload SRC:DST` create flag;
 * throws on non-zero exit. */
export async function uploadToSandbox(
  argvHead: readonly string[],
  name: string,
  localPath: string,
  dest: string,
  cwd?: string,
): Promise<void> {
  const argv = [...argvHead, "sandbox", "upload", name, localPath, dest, "--no-git-ignore"];
  const result = await spawnAndCapture(argv, cwd);
  if (result.code !== 0) {
    throw new Error(
      `sandbox upload ${localPath} -> ${name}:${dest} failed (exit ${result.code}): ${result.stderr}`,
    );
  }
}

export interface ExecInSandboxOpts {
  workdir?: string;
}

/** `sandbox exec --name <n> [--workdir w] --no-tty -- <cmd>` — runs a probe
 * command against an already-Ready sandbox and returns its result (does NOT
 * throw on non-zero, since callers assert on `code`/`stdout`/`stderr`
 * directly, mirroring what `create -- <cmd>`'s stdout used to be parsed
 * from). */
export async function execInSandbox(
  argvHead: readonly string[],
  name: string,
  cmd: string[],
  cwd?: string,
  opts?: ExecInSandboxOpts,
): Promise<SpawnResult> {
  const argv = [
    ...argvHead,
    "sandbox",
    "exec",
    "--name",
    name,
    ...(opts?.workdir !== undefined ? ["--workdir", opts.workdir] : []),
    "--no-tty",
    "--",
    ...cmd,
  ];
  return spawnAndCapture(argv, cwd);
}
