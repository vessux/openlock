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

/**
 * Names of `credentials:` bundles DECLARED in the current .openlock/config
 * that were never attached to this session's sandbox at CREATE time
 * (openlock-04t).
 *
 * Providers attach to a sandbox only when it is created — `--provider`/the
 * attached-provider set is baked into the gateway's SandboxSpec at that
 * point, and reattach can only re-provision the GATEWAY side (restart
 * safety), never attach a new bundle to an already-created container. A
 * bundle added to `.openlock/config.yaml` after create therefore looks fine
 * everywhere (`openlock validate` passes, the gateway provider record
 * exists) but its `cred_inject` fails closed at egress with no openlock-side
 * signal — this function exists to surface exactly that gap on reattach.
 *
 * `recordedAttached` is `undefined` for sessions created before this field
 * existed. That must NOT be read as "recorded empty" — same "can't compare,
 * never a false positive" contract as {@link decideReattachAction}'s
 * `storedHash`: an absent value means unknown, so it returns no names
 * (never warns) rather than flagging every declared bundle as unattached on
 * a legacy session's very first reattach after this feature ships. A
 * present-but-empty array is a real, comparable value (genuinely nothing
 * was attached at create) and DOES flag drift against any declared bundle.
 */
export function findUnattachedCredentialBundles(
  declaredNames: readonly string[],
  recordedAttached: readonly string[] | undefined,
): string[] {
  if (recordedAttached === undefined) return [];
  const attached = new Set(recordedAttached);
  return declaredNames.filter((name) => !attached.has(name));
}
