import { readFileSync } from "node:fs";
import os from "node:os";
import type { DoctorResult } from "../doctor";
import type { Runtime } from "../runtime";
import { SANDBOX_UID } from "./seed-containerfile";
import { rangeCoversUid } from "./subuid";

const SUBUID_FIX =
  "sudo usermod --add-subuids 100000-1100000 --add-subgids 100000-1100000 $USER && podman system migrate";

export interface PreflightDeps {
  runDoctorChecks: () => Promise<DoctorResult[]>;
  hasCredentials: () => boolean;
  isMac: boolean;
  runtime: Runtime;
  podmanMachineRunning: () => Promise<boolean>;
  confirmStartMachine: () => Promise<boolean>;
  ensureHostRuntimeReady: () => Promise<boolean>;
  podmanSocketActive: () => Promise<boolean>;
  dockerDaemonReachable: () => Promise<boolean>;
  login: () => Promise<void>;
  /** Injectable for tests; defaults to reading /etc/subuid on Linux. */
  readSubuid?: () => string;
  /** Injectable for tests; defaults to `process.getuid() === 0`. */
  isRoot?: boolean;
}

export interface PreflightOpts {
  tty: boolean;
  deps: PreflightDeps;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

const MACHINE_NOT_RUNNING_REASON =
  "podman machine is not running. Start it with: podman machine start";

function fail(reason: string): PreflightResult {
  return { ok: false, reason };
}

function checkDoctor(results: DoctorResult[], runtime: Runtime): PreflightResult | null {
  const git = results.find((r) => r.name === "git");
  if (git && !git.ok) return fail("git is required. Install git and re-run.");
  const rt = results.find((r) => r.name === runtime);
  if (rt && !rt.ok) {
    if (runtime === "podman") {
      return fail("podman is required. See https://podman.io/docs/installation");
    }
    return fail("docker is required. See https://docs.docker.com/get-docker/");
  }
  return null;
}

async function ensurePodmanMachine(
  deps: PreflightDeps,
  tty: boolean,
): Promise<PreflightResult | null> {
  if (await deps.podmanMachineRunning()) return null;
  if (!tty) return fail(MACHINE_NOT_RUNNING_REASON);
  if (!(await deps.confirmStartMachine())) return fail(MACHINE_NOT_RUNNING_REASON);
  if (!(await deps.ensureHostRuntimeReady())) {
    return fail("podman machine start failed. See output above.");
  }
  if (!(await deps.podmanMachineRunning())) {
    return fail("podman machine did not reach running state.");
  }
  return null;
}

async function checkRuntimeDaemon(
  deps: PreflightDeps,
  tty: boolean,
): Promise<PreflightResult | null> {
  if (deps.runtime === "podman") {
    if (deps.isMac) return ensurePodmanMachine(deps, tty);
    if (!(await deps.podmanSocketActive())) {
      return fail("podman API socket inactive. Run: systemctl --user enable --now podman.socket");
    }
    return null;
  }
  // docker
  if (!(await deps.dockerDaemonReachable())) {
    return fail(
      deps.isMac
        ? "Docker Desktop does not appear to be running. Open Docker Desktop and retry."
        : "docker daemon not reachable. Start it with: sudo systemctl start docker",
    );
  }
  return null;
}

async function checkCredentials(
  deps: PreflightDeps,
  tty: boolean,
): Promise<PreflightResult | null> {
  if (deps.hasCredentials()) return null;
  if (!tty) return fail("no credentials found. Run: openlock login");
  await deps.login();
  if (!deps.hasCredentials()) return fail("login did not produce credentials.");
  return null;
}

function defaultReadSubuid(): string {
  try {
    return readFileSync("/etc/subuid", "utf8");
  } catch {
    return "";
  }
}

/** Rootless podman on Linux: abort early if the subuid range can't cover SANDBOX_UID. */
function checkSubuid(deps: PreflightDeps): PreflightResult | null {
  const isRoot = deps.isRoot ?? process.getuid?.() === 0;
  // Rootful podman (run as root) doesn't use subuid maps — skip to avoid a false failure.
  if (deps.runtime !== "podman" || deps.isMac || isRoot) return null;
  const reader = deps.readSubuid ?? defaultReadSubuid;
  const content = reader();
  const user = os.userInfo().username || process.env.USER || process.env.LOGNAME || "";
  if (rangeCoversUid(content, user, SANDBOX_UID)) return null;
  return fail(
    `subuid range for '${user}' too small for keep-id:uid=${SANDBOX_UID}. Fix: ${SUBUID_FIX}`,
  );
}

export async function preflight(opts: PreflightOpts): Promise<PreflightResult> {
  const { tty, deps } = opts;
  const results = await deps.runDoctorChecks();
  return (
    checkDoctor(results, deps.runtime) ??
    (await checkRuntimeDaemon(deps, tty)) ??
    checkSubuid(deps) ??
    (await checkCredentials(deps, tty)) ?? { ok: true }
  );
}
