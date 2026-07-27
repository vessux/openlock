import { PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { getCliInvocation } from "./fork-binaries";
import { type Harness, harnessLaunchArgv } from "./harness";
import { filterOpenshellStderr } from "./openshell-stderr";

// "stopped" is split out from "exited" (openlock-weo): phase Stopped is the
// intentional, resumable result of `openlock stop`, not a real failure like
// Failed/Exited. Callers that just issued an explicit Start need to tell the
// two apart — the gateway's phase reconciler lags a running container by up
// to ~35s, so "Stopped" right after StartSandbox returns success is stale
// observation, not death. See assertSandboxNotExited/waitForSandboxReady.
export type ContainerState = "running" | "exited" | "stopped" | "missing" | "other";

// Wrap a command in `env K=V ...` so extra env vars apply without shell
// quoting risk. Returns the original argv unchanged when env is empty.
export function wrapCmdWithEnv(
  cmd: readonly string[],
  env: Readonly<Record<string, string>>,
): string[] {
  const entries = Object.entries(env);
  if (entries.length === 0) return [...cmd];
  const envPairs = entries.map(([k, v]) => `${k}=${v}`);
  return ["env", ...envPairs, ...cmd];
}

export interface OpenshellExecArgvOpts {
  workdir?: string;
  tty?: "auto" | "force" | "off";
  user?: string;
}

// Build argv for `openshell sandbox exec`. The supervisor spawns the command
// inside the sandbox netns with HTTPS_PROXY/Landlock/seccomp applied; routing
// outbound traffic through the proxy is therefore enforced, unlike a raw
// `podman exec` which bypasses the supervisor and lands in the container's
// default netns. See openlock-hnp.
export function buildOpenshellExecArgv(
  cliPrefix: readonly string[],
  name: string,
  cmd: readonly string[],
  opts: OpenshellExecArgvOpts = {},
): string[] {
  const flags: string[] = ["--name", name];
  if (opts.workdir !== undefined) {
    flags.push("--workdir", opts.workdir);
  }
  if (opts.user !== undefined) {
    flags.push("--user", opts.user);
  }
  if (opts.tty === "force") flags.push("--tty");
  else if (opts.tty === "off") flags.push("--no-tty");
  return [...cliPrefix, "sandbox", "exec", ...flags, "--", ...cmd];
}

export function buildHarnessExecArgv(
  cliPrefix: readonly string[],
  harness: Harness,
  sessionName: string,
  extraArgs: readonly string[],
  extraEnv: Readonly<Record<string, string>>,
): string[] {
  const harnessCmd = harnessLaunchArgv(harness, extraArgs);
  const wrapped = wrapCmdWithEnv(harnessCmd, extraEnv);
  return buildOpenshellExecArgv(cliPrefix, sessionName, wrapped, {
    workdir: "/sandbox/repo",
    tty: "force",
  });
}

export interface BuildSandboxEnvArgs {
  providerId: ProviderId;
  harness: Harness;
  repoConfigEnv: Readonly<Record<string, string>>;
}

export function buildSandboxEnv(args: BuildSandboxEnvArgs): Record<string, string> {
  const placeholders = PROVIDERS[args.providerId].sandboxEnvPlaceholders(args.harness);
  // Claude Code reads OAuth/config state (the staged .credentials.json) from
  // CLAUDE_CONFIG_DIR. opencode doesn't use it. The dir is staged under
  // /sandbox/.openlock/ and provisioned by createSession's bootstrap.
  const harnessEnv: Record<string, string> =
    args.harness === "claude_code" ? { CLAUDE_CONFIG_DIR: "/sandbox/.openlock/claude-config" } : {};
  return { ...placeholders, ...harnessEnv, ...args.repoConfigEnv };
}

export async function execHarness(
  harness: Harness,
  sessionName: string,
  extraArgs: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<number> {
  const cli = await getCliInvocation();
  const argv = buildHarnessExecArgv(cli.argv, harness, sessionName, extraArgs, extraEnv);
  const proc = Bun.spawn(argv, {
    cwd: cli.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

export async function execBash(sessionName: string): Promise<number> {
  const cli = await getCliInvocation();
  const argv = buildOpenshellExecArgv(cli.argv, sessionName, ["/bin/bash"], {
    workdir: "/sandbox/repo",
    tty: "force",
  });
  const proc = Bun.spawn(argv, {
    cwd: cli.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

export async function execCmd(sessionName: string, cmd: string[]): Promise<number> {
  const cli = await getCliInvocation();
  const argv = buildOpenshellExecArgv(cli.argv, sessionName, cmd, { workdir: "/sandbox/repo" });
  const proc = Bun.spawn(argv, {
    cwd: cli.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

export interface OpenshellCreateArgs {
  sessionName: string;
  imageTag: string;
  uploadDir: string;
  policy: string;
  providerId: ProviderId;
  command: string[];
  volumeArgs?: readonly string[];
  /** Extra gateway provider names attached to this sandbox in addition to the
   * primary. Each becomes an additional `--provider <name>`; the gateway merges
   * their credentials so policy cred_inject can resolve them. openlock-8ir. */
  attachProviders?: readonly string[];
  /** Opt-in: run the in-container supervisor at debug so the L7 egress
   * request/response header lines surface via `openlock logs`. Off by default. */
  debugEgress?: boolean;
}

export interface OpenshellHandle {
  pid: number;
  /** Resolves when the openshell process exits (typically when the container's foreground command — sleep infinity — terminates). */
  exited: Promise<number>;
}

export function buildOpenshellCreateArgv(args: OpenshellCreateArgs): string[] {
  return [
    "sandbox",
    "create",
    "--name",
    args.sessionName,
    "--from",
    args.imageTag,
    "--upload",
    `${args.uploadDir}:/sandbox/`,
    "--no-git-ignore",
    "--policy",
    args.policy,
    "--provider",
    args.providerId,
    ...(args.attachProviders ?? []).flatMap((name) => ["--provider", name]),
    ...(args.debugEgress === true ? ["--log-level", "debug"] : []),
    "--no-tty",
    ...(args.volumeArgs ?? []),
    "--",
    ...args.command,
  ];
}

/**
 * Stdio for a child that OUTLIVES the openlock CLI — the persistent sandbox
 * tether (`… exec sleep infinity`).
 *
 * INVARIANT (openlock-sqw): a child that survives the CLI must NEVER set
 * stdout/stderr to `"inherit"`. A detached create (`openlock sandbox
 * --no-attach`) returns via `process.exit` while the tether keeps running; an
 * inherited stdout fd would keep a piped/captured caller's stream open forever,
 * hanging `SESSION=$(openlock sandbox --no-attach …)` and any CI capture. So
 * stdout is discarded and stderr is `"pipe"` + drained (also not the parent's
 * fd), surfaced filtered. The gateway daemon obeys the same rule a different
 * way — `spawnDaemonToLog` redirects to a log fd and `unref`s. Any new
 * long-lived `Bun.spawn` MUST follow one of these two patterns, never inherit.
 */
export const TETHER_STDIO = {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "pipe",
} as const;

export function openshellSandboxCreateAsync(args: OpenshellCreateArgs): Promise<OpenshellHandle> {
  return getCliInvocation().then((cli) => {
    const argv = [...cli.argv, ...buildOpenshellCreateArgv(args)];
    const proc = Bun.spawn(argv, { cwd: cli.cwd, ...TETHER_STDIO });
    void pipeFilteredStderr(proc.stderr);
    return {
      pid: proc.pid,
      exited: proc.exited,
    };
  });
}

async function pipeFilteredStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const idx = buffer.lastIndexOf("\n");
      if (idx === -1) continue;
      const flushable = buffer.slice(0, idx + 1);
      buffer = buffer.slice(idx + 1);
      const filtered = filterOpenshellStderr(flushable);
      if (filtered.length > 0) process.stderr.write(filtered);
    }
    if (buffer.length > 0) {
      const filtered = filterOpenshellStderr(buffer);
      if (filtered.length > 0) process.stderr.write(filtered);
    }
  } catch {
    // stream errors are non-fatal; openshell child exit is observed via exited promise
  }
}

const DEFAULT_FAILURE_LOG_LINES = 50;

// `openshell logs <name>` (top-level, NOT `sandbox logs`) is gateway-mediated:
// it reads from the gateway's in-memory log buffer, which the in-container
// supervisor fills via a best-effort push (log_push) as it runs. Unlike
// `openshell sandbox exec`, this works even after the container has exited —
// there's no requirement that the sandbox be Running — so it's the right tool
// to pull whatever the supervisor managed to report (e.g. "Policy fetch
// failed") before it died. Push depends on the same gateway connectivity the
// supervisor needs for policy fetch, so if the container never reached the
// gateway at all, this can legitimately come back empty (see GH #75 / bd
// openlock-7er piece 1 — that's the doctor check's job, not this one's).
export function buildSandboxLogsArgv(
  cliPrefix: readonly string[],
  name: string,
  opts: { lines?: number } = {},
): string[] {
  const lines = opts.lines ?? DEFAULT_FAILURE_LOG_LINES;
  return [...cliPrefix, "logs", name, "-n", String(lines)];
}

async function fetchSandboxFailureLogs(
  name: string,
  lines = DEFAULT_FAILURE_LOG_LINES,
): Promise<string> {
  const cli = await getCliInvocation();
  const argv = buildSandboxLogsArgv(cli.argv, name, { lines });
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

// Pure so it's unit-testable without spawning `openshell logs`.
export function formatSandboxExitedError(name: string, logs: string): string {
  if (logs.length === 0) {
    return (
      `sandbox "${name}" exited during provisioning, and the gateway received no supervisor ` +
      "logs before it did (this usually means the container never reached the gateway over " +
      "the network — run `openlock doctor`; see GH #75). Check the container runtime's own " +
      `logs (e.g. \`podman logs openshell-sandbox-${name}\`) for the underlying error.`
    );
  }
  return `sandbox "${name}" exited during provisioning. Last supervisor logs:\n${logs}`;
}

export interface AssertSandboxNotExitedOpts {
  // Treat phase Stopped as transient rather than a confirmed death. Only
  // correct right after this caller issued an explicit `openshell sandbox
  // start` — there, a lagging phase reconcile (up to ~35s, openlock-weo)
  // can still read Stopped well after the container is actually Up. On a
  // cold wait where nothing was started, Stopped still means
  // dead-and-not-restarting, so this must default to false.
  tolerateStopped?: boolean;
}

// Fails fast with the real cause once the container is confirmed dead
// (Failed/Exited/missing, or Stopped when not tolerated), instead of letting
// callers burn their full poll timeout only to report a generic "not
// ready"/"not visible" message. No-ops (returns normally) while the sandbox
// is merely still provisioning (or transiently Stopped, see above).
export async function assertSandboxNotExited(
  name: string,
  opts: AssertSandboxNotExitedOpts = {},
): Promise<void> {
  const state = await getSandboxState(name);
  if (state === "stopped" && opts.tolerateStopped === true) return;
  if (state !== "exited" && state !== "missing" && state !== "stopped") return;
  const logs = await fetchSandboxFailureLogs(name);
  throw new Error(formatSandboxExitedError(name, logs));
}

export interface WaitForSandboxReadyOpts extends AssertSandboxNotExitedOpts {
  timeoutMs?: number;
}

// Wait until the openshell-sandbox supervisor reports the sandbox in Ready
// phase. `openshell sandbox exec` returns "sandbox not ready" / "sandbox not
// found" until the supervisor finishes provisioning, so probe with a no-op
// /bin/true and retry. Required before any subsequent execHarness/execBash/
// execCmd call.
export async function waitForSandboxReady(
  name: string,
  opts: WaitForSandboxReadyOpts = {},
): Promise<void> {
  const { timeoutMs = 60_000, tolerateStopped } = opts;
  const cli = await getCliInvocation();
  const argv = buildOpenshellExecArgv(cli.argv, name, ["/bin/true"], { tty: "off" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proc = Bun.spawn(argv, {
      cwd: cli.cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await proc.exited) === 0) return;
    await assertSandboxNotExited(name, { tolerateStopped });
    await Bun.sleep(500);
  }
  // Deliberately strict here (no tolerateStopped) even though the loop above
  // polled tolerantly: a Stopped phase we were willing to wait out mid-poll
  // is not the same as a Stopped phase that never resolved across the whole
  // budget — that's a real death (openlock-hsn: Start reports success but
  // the container never actually restarts), and it deserves the specific
  // formatSandboxExitedError (with supervisor logs), not a bare timeout.
  // Runs unconditionally, not gated on `tolerateStopped`: on the cold path
  // it's a no-op duplicate of the strict check the loop already ran every
  // 500ms (so no behavior change there), and on either path it can only
  // ever escalate to a more specific error — a sandbox that's merely slow
  // (state "running"/"other") passes this check cleanly and still falls
  // through to the generic timeout below, so a genuine slow-boot is never
  // masked.
  await assertSandboxNotExited(name);
  throw new Error(`sandbox ${name} did not reach Ready state within ${timeoutMs}ms`);
}

// ============================================================================
// Sandbox-side ops routed through `openshell sandbox <verb>`.
//
// The openshell CLI talks to the configured gateway which itself is driver-
// agnostic (`--drivers podman|docker`), so these argv builders & async
// wrappers do not need to know which runtime is in use. Replaces the previous
// raw-`podman` helpers (inspect / start / stop / rm / cp / secret / volume /
// exec / ps) — gateway/driver owns secret + volume lifecycle and cleans them
// up on `sandbox delete`.
// ============================================================================

// `openshell sandbox get` accepts only [name] + --policy-only — there is no
// -o/--output flag. We parse the human-formatted output for the `Phase:` line
// (the only field getSandboxState consumes).
export function buildSandboxGetArgv(cliPrefix: readonly string[], name: string): string[] {
  return [...cliPrefix, "sandbox", "get", name];
}

export function buildSandboxDeleteArgv(cliPrefix: readonly string[], name: string): string[] {
  return [...cliPrefix, "sandbox", "delete", name];
}

export function buildSandboxStopArgv(cliPrefix: readonly string[], name: string): string[] {
  return [...cliPrefix, "sandbox", "stop", name];
}

export function buildSandboxStartArgv(cliPrefix: readonly string[], name: string): string[] {
  return [...cliPrefix, "sandbox", "start", name];
}

export function buildSandboxUploadArgv(
  cliPrefix: readonly string[],
  name: string,
  local: string,
  dest: string,
): string[] {
  return [...cliPrefix, "sandbox", "upload", name, local, dest];
}

export function buildSandboxDownloadArgv(
  cliPrefix: readonly string[],
  name: string,
  sandboxPath: string,
  dest: string,
): string[] {
  return [...cliPrefix, "sandbox", "download", name, sandboxPath, dest];
}

export function buildSandboxExecRootArgv(
  cliPrefix: readonly string[],
  name: string,
  cmd: readonly string[],
): string[] {
  return buildOpenshellExecArgv(cliPrefix, name, cmd, { user: "root" });
}

export async function getSandboxState(name: string): Promise<ContainerState> {
  const cli = await getCliInvocation();
  const argv = buildSandboxGetArgv(cli.argv, name);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return "missing";
  return parseSandboxGetPhase(out);
}

// Extracts the Phase field from `openshell sandbox get` human output, which
// is colorized + indented like `  Phase: Ready`. Strips ANSI before matching.
export function parseSandboxGetPhase(stdout: string): ContainerState {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC (0x1b) is the point — stripping ANSI CSI sequences.
  const stripped = stdout.replace(/\u001b\[[0-9;]*m/g, "");
  const m = stripped.match(/^\s*Phase:\s*(\S+)/m);
  const phase = m?.[1];
  if (phase === "Ready" || phase === "Running") return "running";
  if (phase === "Stopped") return "stopped";
  if (phase === "Failed" || phase === "Exited") return "exited";
  return "other";
}

export async function deleteSandbox(name: string): Promise<void> {
  const cli = await getCliInvocation();
  const argv = buildSandboxDeleteArgv(cli.argv, name);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  // NotFound is fine — clean is idempotent; surface other failures so we
  // don't leave orphaned podman containers while pretending success.
  if (code !== 0 && !/sandbox not found|NotFound/.test(stderr)) {
    throw new Error(`openshell sandbox delete failed (exit ${code}): ${stderr.trim()}`);
  }
}

// Halt the container without removing it. Workspace volume + cred secret
// survive; reconnect via startSandbox. Used by `openlock stop` and
// reapIdleStaleSessions to avoid destroying user state.
export async function stopSandbox(name: string): Promise<void> {
  const cli = await getCliInvocation();
  const argv = buildSandboxStopArgv(cli.argv, name);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`openshell sandbox stop failed (exit ${code}): ${stderr.trim()}`);
  }
}

// Start a previously-stopped container. Idempotent on already-running
// containers. Throws when the backend resource has been pruned (the
// underlying CLI emits the "backend resource missing" warning and exits
// non-zero only on hard errors).
export async function startSandbox(name: string): Promise<void> {
  const cli = await getCliInvocation();
  const argv = buildSandboxStartArgv(cli.argv, name);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`openshell sandbox start failed (exit ${code}): ${stderr.trim()}`);
  }
}

export async function uploadToSandbox(
  name: string,
  localPath: string,
  destPath: string,
): Promise<void> {
  const cli = await getCliInvocation();
  const argv = buildSandboxUploadArgv(cli.argv, name, localPath, destPath);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`openshell sandbox upload failed (exit ${code}): ${stderr.trim()}`);
  }
}

export async function downloadFromSandbox(
  name: string,
  sandboxPath: string,
  destPath: string,
): Promise<boolean> {
  const cli = await getCliInvocation();
  const argv = buildSandboxDownloadArgv(cli.argv, name, sandboxPath, destPath);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

export async function execAsRoot(name: string, cmd: string[]): Promise<void> {
  const cli = await getCliInvocation();
  const argv = buildSandboxExecRootArgv(cli.argv, name, cmd);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`openshell sandbox exec --user root failed (exit ${code}): ${stderr.trim()}`);
  }
}
