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
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
}

export const SANDBOX_OPENLOCK_PREFIX = "/sandbox/.openlock/";
