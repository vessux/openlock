import type { Harness } from "../sandbox/harness";

export type Severity = "error" | "filesystem";
export type ConfigFile = "config.yaml" | "policy.yaml";

export interface Issue {
  file: ConfigFile;
  severity: Severity;
  path: string;
  message: string;
  fix?: string;
}

export type MountType = "copy-once" | "copy-refresh" | "bind" | "git-bundle";

export interface Mount {
  source: string;
  target: string;
  type: MountType;
  readOnly?: boolean;
}

export interface ManifestConfig {
  /** Agent harness this project was scaffolded for. Persisted by `openlock
   * init` and read back by `openlock sandbox`; absent in hand-authored or
   * pre-existing manifests (which fall through the resolution chain). */
  harness?: Harness;
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
}

export const SANDBOX_OPENLOCK_PREFIX = "/sandbox/.openlock/";
