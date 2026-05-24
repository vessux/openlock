import { PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { getCliInvocation } from "./fork-binaries";
import { type Harness, harnessLaunchArgv } from "./harness";
import { filterOpenshellStderr } from "./openshell-stderr";

export type ContainerState = "running" | "exited" | "missing" | "other";

export async function inspectContainerState(name: string): Promise<ContainerState> {
  const proc = Bun.spawn(["podman", "inspect", name, "--format", "{{.State.Status}}"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return "missing";
  const status = out.trim();
  if (status === "running") return "running";
  if (status === "exited" || status === "stopped") return "exited";
  return "other";
}

export async function startContainer(name: string): Promise<void> {
  const proc = Bun.spawn(["podman", "start", name], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`podman start ${name} failed: ${stderr}`);
}

export async function stopContainer(name: string, graceSeconds = 5): Promise<void> {
  const proc = Bun.spawn(["podman", "stop", "--time", String(graceSeconds), name], {
    stdout: "ignore",
    stderr: "pipe",
  });
  await proc.exited;
}

export async function removeContainer(name: string, force = true): Promise<void> {
  const args = ["podman", "rm", ...(force ? ["-f"] : []), name];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

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
  if (opts.tty === "force") flags.push("--tty");
  else if (opts.tty === "off") flags.push("--no-tty");
  return [...cliPrefix, "sandbox", "exec", ...flags, "--", ...cmd];
}

export function buildHarnessExecArgv(
  cliPrefix: readonly string[],
  harness: Harness,
  name: string,
  extraArgs: readonly string[],
  extraEnv: Readonly<Record<string, string>>,
): string[] {
  const harnessCmd = harnessLaunchArgv(harness, extraArgs);
  const wrapped = wrapCmdWithEnv(harnessCmd, extraEnv);
  return buildOpenshellExecArgv(cliPrefix, name, wrapped, { workdir: "/sandbox/repo" });
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
  name: string,
  extraArgs: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<number> {
  const cli = await getCliInvocation();
  const argv = buildHarnessExecArgv(cli.argv, harness, name, extraArgs, extraEnv);
  const proc = Bun.spawn(argv, {
    cwd: cli.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

export async function execBash(name: string): Promise<number> {
  const cli = await getCliInvocation();
  const argv = buildOpenshellExecArgv(cli.argv, name, ["/bin/bash"], { workdir: "/sandbox/repo" });
  const proc = Bun.spawn(argv, {
    cwd: cli.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

export async function execCmd(name: string, cmd: string[]): Promise<number> {
  const cli = await getCliInvocation();
  const argv = buildOpenshellExecArgv(cli.argv, name, cmd, { workdir: "/sandbox/repo" });
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

export async function waitForContainerRunning(name: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await inspectContainerState(name)) === "running") return;
    await Bun.sleep(500);
  }
  throw new Error(`container ${name} did not reach running state within ${timeoutMs}ms`);
}

export async function copyOutOfContainer(
  name: string,
  src: string,
  dest: string,
): Promise<boolean> {
  const proc = Bun.spawn(["podman", "cp", `${name}:${src}`, dest], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function removeSecret(name: string): Promise<void> {
  const rm = Bun.spawn(["podman", "secret", "rm", name], { stdout: "ignore", stderr: "ignore" });
  await rm.exited;
}

export async function removeVolume(name: string): Promise<void> {
  const rm = Bun.spawn(["podman", "volume", "rm", name], { stdout: "ignore", stderr: "ignore" });
  await rm.exited;
}

export function buildPodmanCpArgv(
  hostPath: string,
  name: string,
  containerDestDir: string,
): string[] {
  return ["podman", "cp", hostPath, `${name}:${containerDestDir}`];
}

export function buildPodmanRmArgv(name: string, containerPath: string): string[] {
  return ["podman", "exec", "-u", "root", name, "rm", "-rf", containerPath];
}

export function buildPodmanChownArgv(name: string, containerPath: string): string[] {
  return ["podman", "exec", "-u", "root", name, "chown", "-R", "sandbox:sandbox", containerPath];
}

async function spawnExitCode(argv: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

export async function podmanCpInto(
  hostPath: string,
  name: string,
  containerDestDir: string,
): Promise<void> {
  const { code, stderr } = await spawnExitCode(buildPodmanCpArgv(hostPath, name, containerDestDir));
  if (code !== 0) {
    throw new Error(
      `podman cp ${hostPath} -> ${name}:${containerDestDir} failed (exit ${code}): ${stderr.trim()}`,
    );
  }
}

export async function podmanExecRmRf(name: string, containerPath: string): Promise<void> {
  const { code, stderr } = await spawnExitCode(buildPodmanRmArgv(name, containerPath));
  if (code !== 0) {
    throw new Error(
      `podman exec ${name} rm -rf ${containerPath} failed (exit ${code}): ${stderr.trim()}`,
    );
  }
}

export async function podmanExecChownSandbox(name: string, containerPath: string): Promise<void> {
  const { code, stderr } = await spawnExitCode(buildPodmanChownArgv(name, containerPath));
  if (code !== 0) {
    throw new Error(
      `podman exec ${name} chown ${containerPath} failed (exit ${code}): ${stderr.trim()}`,
    );
  }
}

export async function listSandboxContainers(
  prefix: string,
  includeExited = false,
): Promise<string[]> {
  const args = ["podman", "ps", "--format", "{{.Names}}", "--filter", `name=${prefix}`];
  if (includeExited) args.splice(2, 0, "--all");
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
