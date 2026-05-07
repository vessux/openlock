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

export async function preflight(opts: PreflightOpts): Promise<PreflightResult> {
  const { tty, deps } = opts;

  const results = await deps.runDoctorChecks();

  const git = results.find((r) => r.name === "git");
  if (git && !git.ok) {
    return { ok: false, reason: "git is required. Install git and re-run." };
  }

  const podman = results.find((r) => r.name === "podman");
  if (podman && !podman.ok) {
    return {
      ok: false,
      reason: "podman is required. See https://podman.io/docs/installation",
    };
  }

  if (deps.isMac) {
    let running = await deps.podmanMachineRunning();
    if (!running) {
      if (!tty) {
        return {
          ok: false,
          reason: "podman machine is not running. Start it with: podman machine start",
        };
      }
      const consented = await deps.confirmStartMachine();
      if (!consented) {
        return {
          ok: false,
          reason: "podman machine is not running. Start it with: podman machine start",
        };
      }
      const started = await deps.startPodmanMachine();
      if (!started) {
        return { ok: false, reason: "podman machine start failed. See output above." };
      }
      running = await deps.podmanMachineRunning();
      if (!running) {
        return { ok: false, reason: "podman machine did not reach running state." };
      }
    }
  } else {
    const active = await deps.podmanSocketActive();
    if (!active) {
      return {
        ok: false,
        reason:
          "podman API socket inactive. Run: systemctl --user enable --now podman.socket",
      };
    }
  }

  if (deps.readToken() === null) {
    if (!tty) {
      return {
        ok: false,
        reason: "no credentials found. Run: openlock login",
      };
    }
    await deps.login();
    if (deps.readToken() === null) {
      return { ok: false, reason: "login did not produce a token." };
    }
  }

  return { ok: true };
}
