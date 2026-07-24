import type { Harness } from "../sandbox/harness";

export type Severity = "error" | "filesystem";
export type ConfigFile = "config.yaml" | "config.local.yaml" | "policy.yaml";

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

/** A source spec for one credential value. v1 supports host-env references only.
 * Not exported standalone: nothing outside this file needs to name it directly
 * (consumers go through `CredentialBundle["values"]`); re-add `export` if a
 * later unit needs to import it by name. */
interface CredentialSource {
  from_env: string;
}

/** A named secondary-credential bundle declared in .openlock/config.yaml.
 * Provisioned into the gateway as a `generic` provider and attached to the
 * sandbox so `cred_inject.from_credential` in policy.yaml can resolve it.
 * The credential VALUE is read from host env at run-time, never committed and
 * never injected into the sandbox env. */
export interface CredentialBundle {
  name: string;
  values: Record<string, CredentialSource>;
}

export interface ManifestConfig {
  /** Agent harness this project was scaffolded for. Persisted by `openlock
   * init` and read back by `openlock sandbox`; absent in hand-authored or
   * pre-existing manifests (which fall through the resolution chain). */
  harness?: Harness;
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
  credentials: CredentialBundle[];
}

export const SANDBOX_OPENLOCK_PREFIX = "/sandbox/.openlock/";
