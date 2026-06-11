import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { commandExists } from "./command-exists";
import { readGlobalConfig } from "./global-config";
import { globalConfigPath } from "./global-config/paths";
import { forkDir } from "./paths";
import { type BinaryProbes, RUNTIMES, type Runtime } from "./runtime";
import { isDevMode } from "./sandbox/fork-binaries";
import { SANDBOX_UID } from "./sandbox/seed-containerfile";
import { rangeCoversUid } from "./sandbox/subuid";
import { hasAnyProvider } from "./tokens";

const SUBUID_FIX =
  "sudo usermod --add-subuids 100000-1100000 --add-subgids 100000-1100000 $USER && podman system migrate";

/** Read /etc/subuid for injection in tests; defaults to the real file. */
function defaultReadSubuid(): string {
  try {
    return readFileSync("/etc/subuid", "utf8");
  } catch {
    return "";
  }
}

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

/** Rootless podman (Linux only): verify the host subuid range covers SANDBOX_UID.
 * Returns an empty array on macOS or when podman is not the runtime. */
export function buildSubuidCheck(
  hasPodman: boolean,
  isMac: boolean,
  readSubuid: () => string,
): Check[] {
  if (!hasPodman || isMac) return [];
  return [
    {
      name: "rootless podman subuid range",
      test: (): Promise<CheckOutcome> => {
        const user = os.userInfo().username || process.env.USER || process.env.LOGNAME || "";
        const content = readSubuid();
        const ok = rangeCoversUid(content, user, SANDBOX_UID);
        return Promise.resolve(
          ok
            ? { ok: true }
            : {
                ok: false,
                detail: `subuid count for '${user}' must exceed ${SANDBOX_UID} (keep-id:uid=${SANDBOX_UID} mapping)`,
                fix: SUBUID_FIX,
              },
        );
      },
    },
  ];
}

export async function runDoctorChecks(
  runtime?: Runtime | null,
  readSubuid: () => string = defaultReadSubuid,
): Promise<DoctorResult[]> {
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
  // Rootless podman (Linux only) requires the host's subuid range to cover
  // the in-image sandbox UID so `--userns=keep-id:uid=N` can map it.
  const subuidChecks = buildSubuidCheck(probes.podman, isMac, readSubuid);

  const checks: Check[] = [
    { name: "git", test: async () => commandExists("git"), fix: installHint("git") },
    ...runtimeChecks,
    ...subuidChecks,
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
