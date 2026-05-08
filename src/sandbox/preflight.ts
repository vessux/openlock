import type { DoctorResult } from "../doctor";

export interface PreflightDeps {
  runDoctorChecks: () => Promise<DoctorResult[]>;
  readToken: () => string | null;
  isMac: boolean;
  podmanMachineRunning: () => Promise<boolean>;
  confirmStartMachine: () => Promise<boolean>;
  startPodmanMachine: () => Promise<boolean>;
  podmanSocketActive: () => Promise<boolean>;
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

function checkDoctor(results: DoctorResult[]): PreflightResult | null {
  const git = results.find((r) => r.name === "git");
  if (git && !git.ok) return fail("git is required. Install git and re-run.");
  const podman = results.find((r) => r.name === "podman");
  if (podman && !podman.ok) {
    return fail("podman is required. See https://podman.io/docs/installation");
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
  if (!(await deps.startPodmanMachine())) {
    return fail("podman machine start failed. See output above.");
  }
  if (!(await deps.podmanMachineRunning())) {
    return fail("podman machine did not reach running state.");
  }
  return null;
}

async function checkPodmanRuntime(
  deps: PreflightDeps,
  tty: boolean,
): Promise<PreflightResult | null> {
  if (deps.isMac) return ensurePodmanMachine(deps, tty);
  if (!(await deps.podmanSocketActive())) {
    return fail("podman API socket inactive. Run: systemctl --user enable --now podman.socket");
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
    checkDoctor(results) ??
    (await checkPodmanRuntime(deps, tty)) ??
    (await checkCredentials(deps, tty)) ?? { ok: true }
  );
}
