import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandExists } from "./command-exists";
import { readGlobalConfig } from "./global-config";
import { globalConfigPath } from "./global-config/paths";
import { forkDir } from "./paths";
import { type BinaryProbes, RUNTIMES, type Runtime } from "./runtime";
import { isDevMode } from "./sandbox/fork-binaries";
import { hasAnyProvider } from "./tokens";

const DOCKER_INSTALL_DOCS = "https://docs.docker.com/engine/install/";

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

/** Presence + readiness checks for a single installed runtime. */
function runtimeChecksFor(rt: Runtime, isMac: boolean): Check[] {
  const readiness: Check =
    rt === "podman"
      ? isMac
        ? {
            name: "podman machine (running)",
            test: podmanMachineRunning,
            fix: "podman machine start",
          }
        : {
            name: "podman API socket active",
            test: podmanSocketActive,
            fix: "systemctl --user enable --now podman.socket",
          }
      : {
          name: "docker daemon reachable",
          test: dockerDaemonReachable,
          fix: "start Docker (systemctl --user start docker, or launch Docker Desktop)",
        };
  return [
    {
      name: rt,
      test: async () => commandExists(rt),
      fix: rt === "podman" ? installHint("podman") : DOCKER_INSTALL_DOCS,
    },
    readiness,
  ];
}

/** Report EVERY installed runtime and its readiness. A host with both podman
 * and docker shows both — the prior code collapsed "two present" into the same
 * null result as "none present", a false negative (the resolver only
 * auto-picks when exactly one is installed). Only when neither is present do we
 * emit the single install-a-runtime failure. */
export function buildRuntimeChecks(probes: BinaryProbes, isMac: boolean): Check[] {
  const present = RUNTIMES.filter((r) => probes[r]);
  if (present.length === 0) {
    return [
      {
        name: "container runtime (podman/docker)",
        test: async () => false,
        fix: `${installHint("podman")}, or install docker: ${DOCKER_INSTALL_DOCS}`,
      },
    ];
  }
  return present.flatMap((r) => runtimeChecksFor(r, isMac));
}

export async function runDoctorChecks(runtime?: Runtime | null): Promise<DoctorResult[]> {
  // No explicit runtime (standalone `openlock doctor`, report) → probe both and
  // report every installed runtime. An explicit runtime (e.g. session preflight,
  // where it's already resolved) narrows to that one; explicit null → no runtime.
  const probes: BinaryProbes =
    runtime === undefined
      ? { podman: commandExists("podman"), docker: commandExists("docker") }
      : { podman: runtime === "podman", docker: runtime === "docker" };
  const isMac = process.platform === "darwin";
  const dev = isDevMode();

  const runtimeChecks = buildRuntimeChecks(probes, isMac);

  const checks: Check[] = [
    { name: "git", test: async () => commandExists("git"), fix: installHint("git") },
    ...runtimeChecks,
    ...(dev
      ? [
          {
            name: "bun",
            test: async () => commandExists("bun"),
            fix: "curl -fsSL https://bun.sh/install | bash",
          },
          {
            name: "cargo",
            test: async () => commandExists("cargo"),
            fix: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
          },
          ...(isMac
            ? [
                {
                  name: "cargo-zigbuild",
                  test: async () => commandExists("cargo-zigbuild"),
                  fix: "cargo install cargo-zigbuild",
                },
              ]
            : []),
          {
            name: "openshell-fork directory",
            test: async () => existsSync(join(forkDir(), ".git")),
            fix: `clone the openshell fork into ${forkDir()} (dev setup)`,
          },
        ]
      : []),
    {
      name: "credentials (openlock login)",
      test: async () => hasAnyProvider(),
      fix: "openlock login",
    },
    {
      name: `global config (${globalConfigPath()})`,
      test: checkGlobalConfig,
      fix: `edit or remove ${globalConfigPath()}`,
    },
  ];

  const results: DoctorResult[] = [];
  for (const c of checks) {
    const outcome = await c.test();
    const co = typeof outcome === "boolean" ? undefined : outcome;
    const r: DoctorResult = {
      name: c.name,
      ok: typeof outcome === "boolean" ? outcome : outcome.ok,
    };
    if (co?.detail !== undefined) r.detail = co.detail;
    const fix = co?.fix ?? c.fix;
    if (fix !== undefined) r.fix = fix;
    results.push(r);
  }
  return results;
}

/** Render doctor results to display lines + a failure count. Pure (no I/O) so
 * the formatting — notably that `fix:` prints only for failed checks — is unit
 * testable without `doctor()`'s `process.exit`. */
export function renderDoctorResults(results: DoctorResult[]): {
  lines: string[];
  failures: number;
} {
  const lines: string[] = [];
  let failures = 0;
  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    lines.push(`  ${icon} ${r.name}`);
    if (r.detail !== undefined) lines.push(`      ${r.detail}`);
    if (!r.ok && r.fix !== undefined) lines.push(`      fix: ${r.fix}`);
    if (!r.ok) failures++;
  }
  return { lines, failures };
}

export async function doctor(): Promise<void> {
  const results = await runDoctorChecks();
  const { lines, failures } = renderDoctorResults(results);
  for (const line of lines) console.log(line);

  console.log();
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("All checks passed.");
  }
}
