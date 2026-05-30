import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandExists } from "./command-exists";
import { readGlobalConfig } from "./global-config";
import { globalConfigPath } from "./global-config/paths";
import { forkDir } from "./paths";
import { type Runtime, resolveRuntime } from "./runtime";
import { isDevMode } from "./sandbox/fork-binaries";
import { hasAnyProvider } from "./tokens";

/** Platform-aware install command. Mac uses brew; Linux assumes apt and lets
 * non-Debian users substitute their own package manager. */
export function installHint(pkg: string, platform: NodeJS.Platform = process.platform): string {
  const pm = platform === "darwin" ? "brew" : "apt";
  return `${pm} install ${pkg}`;
}

interface CheckOutcome {
  ok: boolean;
  detail?: string;
  fix?: string;
}

interface Check {
  name: string;
  test: () => Promise<boolean | CheckOutcome>;
  fix?: string;
}

export async function podmanMachineRunning(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["podman", "machine", "info"], { stdout: "pipe", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) return false;
    const output = await new Response(proc.stdout).text();
    return /machinestate:\s*Running/i.test(output);
  } catch {
    return false;
  }
}

export async function dockerDaemonReachable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function podmanSocketActive(): Promise<boolean> {
  // `podman info` succeeds even when the API socket is inactive (the CLI
  // talks to libpod directly), and a stale socket *file* can linger after
  // `systemctl stop`. The only reliable check is to actually open a
  // connection and ping the API — which is what the gateway does.
  // Bound the curl call with --max-time so a stale socket can't hang us.
  try {
    const proc = Bun.spawn(["podman", "info", "--format", "{{.Host.RemoteSocket.Path}}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return false;
    const socketPath = out.trim().replace(/^unix:\/\//, "");
    const ping = Bun.spawn(
      ["curl", "-fsS", "--max-time", "2", "--unix-socket", socketPath, "http://d/_ping"],
      { stdout: "ignore", stderr: "ignore" },
    );
    return (await ping.exited) === 0;
  } catch {
    return false;
  }
}

export interface DoctorResult {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

async function checkGlobalConfig(): Promise<CheckOutcome> {
  try {
    readGlobalConfig();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg };
  }
}

export async function runDoctorChecks(runtime?: Runtime): Promise<DoctorResult[]> {
  const resolved = runtime ?? (await resolveRuntime());
  const isMac = process.platform === "darwin";
  const dev = isDevMode();
  const checks: Check[] = [
    { name: "git", test: async () => commandExists("git") },
    { name: resolved, test: async () => commandExists(resolved) },
    ...(resolved === "podman"
      ? [
          isMac
            ? { name: "podman machine (running)", test: podmanMachineRunning }
            : { name: "podman API socket active", test: podmanSocketActive },
        ]
      : [{ name: "docker daemon reachable", test: dockerDaemonReachable }]),
    ...(dev
      ? [
          { name: "bun", test: async () => commandExists("bun") },
          { name: "cargo", test: async () => commandExists("cargo") },
          ...(isMac
            ? [{ name: "cargo-zigbuild", test: async () => commandExists("cargo-zigbuild") }]
            : []),
          {
            name: "openshell-fork directory",
            test: async () => existsSync(join(forkDir(), ".git")),
          },
        ]
      : []),
    {
      name: "credentials (openlock login)",
      test: async () => hasAnyProvider(),
    },
    {
      name: `global config (${globalConfigPath()})`,
      test: checkGlobalConfig,
    },
  ];

  const results: DoctorResult[] = [];
  for (const c of checks) {
    const outcome = await c.test();
    if (typeof outcome === "boolean") {
      results.push({ name: c.name, ok: outcome });
    } else {
      const r: DoctorResult = { name: c.name, ok: outcome.ok };
      if (outcome.detail !== undefined) r.detail = outcome.detail;
      results.push(r);
    }
  }
  return results;
}

export async function doctor(): Promise<void> {
  const results = await runDoctorChecks();
  let failures = 0;
  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${r.name}`);
    if (r.detail !== undefined) console.log(`      ${r.detail}`);
    if (!r.ok) failures++;
  }

  console.log();
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("All checks passed.");
  }
}
