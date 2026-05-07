import { existsSync } from "fs";
import { join } from "path";
import { readToken } from "./tokens";
import { forkDir } from "./paths";
import { isDevMode } from "./sandbox/fork-binaries";

interface Check {
  name: string;
  test: () => Promise<boolean>;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function podmanMachineRunning(): Promise<boolean> {
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

async function podmanSocketActive(): Promise<boolean> {
  // `podman info` succeeds even when the API socket is inactive (the CLI
  // talks to libpod directly), and a stale socket *file* can linger after
  // `systemctl stop`. The only reliable check is to actually open a
  // connection and ping the API — which is what the gateway does.
  try {
    const proc = Bun.spawn(
      ["podman", "info", "--format", "{{.Host.RemoteSocket.Path}}"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return false;
    const socketPath = out.trim().replace(/^unix:\/\//, "");
    const ping = Bun.spawn(
      ["curl", "-fsS", "--unix-socket", socketPath, "http://d/_ping"],
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
}

export async function runDoctorChecks(): Promise<DoctorResult[]> {
  const isMac = process.platform === "darwin";
  const dev = isDevMode();
  const checks: Check[] = [
    { name: "git", test: () => commandExists("git") },
    { name: "podman", test: () => commandExists("podman") },
    isMac
      ? { name: "podman machine (running)", test: podmanMachineRunning }
      : { name: "podman API socket active", test: podmanSocketActive },
    ...(dev
      ? [
          { name: "bun", test: () => commandExists("bun") },
          { name: "cargo", test: () => commandExists("cargo") },
          ...(isMac
            ? [{ name: "cargo-zigbuild", test: () => commandExists("cargo-zigbuild") }]
            : []),
          {
            name: "openshell-fork directory",
            test: async () => existsSync(join(forkDir(), ".git")),
          },
        ]
      : []),
    {
      name: "credentials (openlock login)",
      test: async () => readToken() !== null,
    },
  ];

  const results: DoctorResult[] = [];
  for (const c of checks) {
    results.push({ name: c.name, ok: await c.test() });
  }
  return results;
}

export async function doctor(): Promise<void> {
  const results = await runDoctorChecks();
  let failures = 0;
  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${r.name}`);
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
