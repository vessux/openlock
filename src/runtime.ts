// src/runtime.ts

import { readGlobalConfig } from "./global-config";
import type { GlobalConfig } from "./global-config/schema";
import { runWizard } from "./runtime-wizard";

export const RUNTIMES = ["podman", "docker"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export function parseRuntime(raw: string): Runtime | null {
  const v = raw.trim().toLowerCase();
  if (v === "podman" || v === "docker") return v;
  return null;
}

export interface RuntimeSources {
  env: Runtime | string | null;
  config: Runtime | null;
  autodetected: Runtime | null;
}

export function pickRuntime(s: RuntimeSources): Runtime | null {
  if (typeof s.env === "string") {
    const v = parseRuntime(s.env);
    if (v !== null) return v;
  }
  if (s.config !== null) return s.config;
  if (s.autodetected !== null) return s.autodetected;
  return null;
}

export interface BinaryProbes {
  podman: boolean;
  docker: boolean;
}

export function autodetectRuntimeFromProbes(p: BinaryProbes): Runtime | null {
  if (p.podman) return "podman";
  if (p.docker) return "docker";
  return null;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function probeBinaries(): Promise<BinaryProbes> {
  const [podman, docker] = await Promise.all([commandExists("podman"), commandExists("docker")]);
  return { podman, docker };
}

export async function autodetectRuntime(): Promise<Runtime | null> {
  return autodetectRuntimeFromProbes(await probeBinaries());
}

export interface GetRuntimeOpts {
  readConfig: () => Pick<GlobalConfig, "defaultRuntime">;
  probe: () => Promise<BinaryProbes>;
  /** Invoked when env+config unset AND autodetect can't pick unambiguously
   * (zero or two binaries present). Returning a Runtime persists nothing —
   * callers wanting persistence wire that up themselves. */
  onMissing: (probes: BinaryProbes) => Promise<Runtime>;
}

export async function getRuntime(opts: GetRuntimeOpts): Promise<Runtime> {
  const envRaw = process.env.OPENLOCK_RUNTIME ?? null;
  const env = envRaw !== null ? parseRuntime(envRaw) : null;
  const config = opts.readConfig().defaultRuntime ?? null;

  if (env !== null) return env;
  if (config !== null) return config;

  const probes = await opts.probe();
  const single = (probes.podman ? 1 : 0) + (probes.docker ? 1 : 0);
  if (single === 1) {
    return probes.podman ? "podman" : "docker";
  }
  // ambiguous (both present) or missing (neither) — defer to caller.
  return opts.onMissing(probes);
}

let cached: Runtime | null = null;

export async function resolveRuntime(): Promise<Runtime> {
  if (cached !== null) return cached;
  const rt = await getRuntime({
    readConfig: () => {
      try {
        return readGlobalConfig() ?? {};
      } catch {
        return {};
      }
    },
    probe: probeBinaries,
    onMissing: async (probes) => runWizard(probes),
  });
  cached = rt;
  return rt;
}

export function _clearCachedRuntimeForTests(): void {
  cached = null;
}
