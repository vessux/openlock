import type { DoctorResult } from "../doctor";
import type { Runtime } from "../runtime";

export interface PreflightDeps {
  runDoctorChecks: () => Promise<DoctorResult[]>;
  readToken: () => string | null;
  isMac: boolean;
  runtime: Runtime;
  podmanMachineRunning: () => Promise<boolean>;
  confirmStartMachine: () => Promise<boolean>;
  ensureHostRuntimeReady: () => Promise<boolean>;
  podmanSocketActive: () => Promise<boolean>;
  dockerDaemonReachable: () => Promise<boolean>;
  login: () => Promise<void>;
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
  if (deps.readToken() !== null) return null;
  if (!tty) return fail("no credentials found. Run: openlock login");
  await deps.login();
  if (deps.readToken() === null) return fail("login did not produce a token.");
  return null;
}

export async function preflight(opts: PreflightOpts): Promise<PreflightResult> {
  const { tty, deps } = opts;
  const results = await deps.runDoctorChecks();
  return (
    checkDoctor(results, deps.runtime) ??
    (await checkRuntimeDaemon(deps, tty)) ??
    (await checkCredentials(deps, tty)) ?? { ok: true }
  );
}
