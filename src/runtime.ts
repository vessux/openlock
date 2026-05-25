// src/runtime.ts
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

export async function autodetectRuntime(): Promise<Runtime | null> {
  const [podman, docker] = await Promise.all([commandExists("podman"), commandExists("docker")]);
  return autodetectRuntimeFromProbes({ podman, docker });
}
