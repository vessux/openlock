import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Mount } from "../config-core/types";

/** Canonical, key-order- and readOnly-default-stable serialization of one mount. */
function canonicalMount(m: Mount): string {
  return `${m.type}\0${m.source}\0${m.target}\0${m.readOnly ? "ro" : "rw"}`;
}

/**
 * Hash of the inputs that are baked into a sandbox container at CREATE time and
 * cannot be applied to a running/stopped container on reattach ("cold" inputs):
 * the resolved Containerfile, the mount set, and the policy file content.
 *
 * Deliberately excludes args/env/credentials — those are re-applied on every
 * attach (harness launch argv, gateway re-provision) and so never require a
 * rebuild. Mount ordering and object key order do not affect the result.
 */
export function computeBuildInputsHash(
  containerfileContent: string,
  mounts: readonly Mount[],
  policyContent: string,
): string {
  const mountsBlock = mounts.map(canonicalMount).sort().join("\n");
  const payload = `${containerfileContent}\x1e${policyContent}\x1e${mountsBlock}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Same hash as {@link computeBuildInputsHash} but reads the Containerfile and
 * policy from disk. Returns `undefined` if either file can't be read (e.g. the
 * `--policy` override path with no `.openlock/Containerfile`), which callers
 * treat as "can't compare" — never a false drift signal.
 */
export function computeBuildInputsHashFromFiles(
  containerfilePath: string,
  mounts: readonly Mount[],
  policyPath: string,
): string | undefined {
  let containerfileContent: string;
  let policyContent: string;
  try {
    containerfileContent = readFileSync(containerfilePath, "utf-8");
    policyContent = readFileSync(policyPath, "utf-8");
  } catch {
    return undefined;
  }
  return computeBuildInputsHash(containerfileContent, mounts, policyContent);
}

/** What to do when reattaching to an existing session. */
export type ReattachAction =
  /** No drift (or a legacy session with no recorded hash) — attach as-is. */
  | "proceed"
  /** Cold inputs drifted and the user forced a rebuild via --rebuild. */
  | "rebuild"
  /** Cold inputs drifted, interactive terminal — ask the user y/N. */
  | "prompt"
  /** Cold inputs drifted, non-interactive — warn and attach the stale container. */
  | "warn-stale";

/**
 * Decide how to reattach given whether the container's baked-in build inputs
 * still match the current `.openlock/` config.
 *
 * - An explicit `--rebuild` is honored first, regardless of drift: the user
 *   asked to force a fresh image build + container recreate, so we never
 *   silently swallow it (that also covers refreshing a moved mutable `FROM`
 *   tag, whose Containerfile text — and thus hash — is unchanged).
 * - `storedHash` is `undefined` for sessions created before drift-tracking
 *   existed; `currentHash` is `undefined` when the current inputs can't be
 *   read. Either way we can't compare, so (absent `--rebuild`) we proceed
 *   without prompting — never a false positive.
 */
export function decideReattachAction(args: {
  storedHash: string | undefined;
  currentHash: string | undefined;
  rebuildFlag: boolean;
  interactive: boolean;
}): ReattachAction {
  if (args.rebuildFlag) return "rebuild";
  const drifted =
    args.storedHash !== undefined &&
    args.currentHash !== undefined &&
    args.storedHash !== args.currentHash;
  if (!drifted) return "proceed";
  return args.interactive ? "prompt" : "warn-stale";
}
