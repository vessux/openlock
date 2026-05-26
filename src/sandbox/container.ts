import { PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { getCliInvocation } from "./fork-binaries";
import { type Harness, harnessLaunchArgv } from "./harness";
import { filterOpenshellStderr } from "./openshell-stderr";

export type ContainerState = "running" | "exited" | "missing" | "other";

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
  return { ...placeholders, ...args.repoConfigEnv };
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
    "--no-tty",
    ...(args.volumeArgs ?? []),
    "--",
    ...args.command,
  ];
}

export function openshellSandboxCreateAsync(args: OpenshellCreateArgs): Promise<OpenshellHandle> {
  return getCliInvocation().then((cli) => {
    const argv = [...cli.argv, ...buildOpenshellCreateArgv(args)];
    const proc = Bun.spawn(argv, {
      cwd: cli.cwd,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "pipe",
    });
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

// Wait until the openshell-sandbox supervisor reports the sandbox in Ready
// phase. `openshell sandbox exec` returns "sandbox not ready" / "sandbox not
// found" until the supervisor finishes provisioning, so probe with a no-op
// /bin/true and retry. Required before any subsequent execHarness/execBash/
// execCmd call.
export async function waitForSandboxReady(name: string, timeoutMs = 60_000): Promise<void> {
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
    await Bun.sleep(500);
  }
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

export function buildSandboxGetArgv(cliPrefix: readonly string[], name: string): string[] {
  return [...cliPrefix, "sandbox", "get", name, "-o", "json"];
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

export function buildSandboxListNamesArgv(cliPrefix: readonly string[]): string[] {
  return [...cliPrefix, "sandbox", "list", "--names"];
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
  try {
    const json = JSON.parse(out);
    // `openshell sandbox get` returns { status: { phase: "Ready"|"Failed"|... }, ... }
    const phase = json?.status?.phase ?? json?.phase;
    if (phase === "Ready" || phase === "Running") return "running";
    if (phase === "Failed" || phase === "Exited") return "exited";
    return "other";
  } catch {
    return "other";
  }
}

export async function deleteSandbox(name: string): Promise<void> {
  const cli = await getCliInvocation();
  const argv = buildSandboxDeleteArgv(cli.argv, name);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
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

export async function listSandboxes(prefix?: string): Promise<string[]> {
  const cli = await getCliInvocation();
  const argv = buildSandboxListNamesArgv(cli.argv);
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const names = out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return prefix ? names.filter((n) => n.startsWith(prefix)) : names;
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
