// src/runtime.ts

import { commandExists } from "./command-exists";
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

export type BinaryProbes = Record<Runtime, boolean>;

export function autodetectRuntimeFromProbes(p: BinaryProbes): Runtime | null {
  if (p.podman) return "podman";
  if (p.docker) return "docker";
  return null;
}

async function probeBinaries(): Promise<BinaryProbes> {
  return { podman: commandExists("podman"), docker: commandExists("docker") };
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

function readConfigSafe(): Pick<GlobalConfig, "defaultRuntime"> {
  try {
    return readGlobalConfig() ?? {};
  } catch {
    return {};
  }
}

const NO_RUNTIME = Symbol("no-runtime");

/** Resolve the runtime without ever launching the interactive picker. Returns
 * null when env+config are unset and autodetect is ambiguous (zero or two
 * binaries). Safe to call from non-TTY contexts (e.g. install.sh). */
export async function resolveRuntimeNonInteractive(): Promise<Runtime | null> {
  try {
    return await getRuntime({
      readConfig: readConfigSafe,
      probe: probeBinaries,
      onMissing: async () => {
        throw NO_RUNTIME;
      },
    });
  } catch (e) {
    if (e === NO_RUNTIME) return null;
    throw e;
  }
}

let cached: Runtime | null = null;

export async function resolveRuntime(): Promise<Runtime> {
  if (cached !== null) return cached;
  const rt = await getRuntime({
    readConfig: readConfigSafe,
    probe: probeBinaries,
    onMissing: async (probes) => runWizard(probes),
  });
  cached = rt;
  return rt;
}

export function _clearCachedRuntimeForTests(): void {
  cached = null;
}
