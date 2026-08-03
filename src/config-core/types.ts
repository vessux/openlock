import type { Harness } from "../sandbox/harness";

/** "warning" is non-blocking (doesn't fail `openlock validate`'s exit code) —
 * reserved for heuristic lints that name a real risk without being certain
 * enough of a false-positive-free signal to justify erroring, per the project
 * convention of informing over refusing documented-risk configurations. */
export type Severity = "error" | "filesystem" | "warning";
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
  /** CPU limit passed through verbatim to `openshell sandbox create --cpu`
   * (e.g. "2", "500m", "0.5"). Absent means openlock does not pass --cpu at
   * all, so the sandbox inherits openshell's own default — openlock does not
   * fork that default without a reason; it only makes it overridable and
   * visible (openlock-251: openlock previously set no limit anywhere, so
   * every sandbox silently inherited openshell's cpu_limit=2 regardless of
   * the host's actual resources). */
  cpu?: string;
  /** Memory limit passed through verbatim to `openshell sandbox create
   * --memory` (e.g. "4Gi", "512Mi", "8G"). Absent means openlock does not
   * pass --memory at all, so the sandbox inherits openshell's own default —
   * same reasoning as `cpu` above (openlock-251). */
  memory?: string;
}

export const SANDBOX_OPENLOCK_PREFIX = "/sandbox/.openlock/";
