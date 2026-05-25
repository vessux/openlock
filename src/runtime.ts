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
