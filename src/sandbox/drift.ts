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

/**
 * Warning line when `--debug-egress` is requested on a path that will NOT
 * (re-)apply it — a plain reattach to an already-running container (bd
 * openlock-tgfk). `debugEgress` is a cold build input: it only ever takes
 * effect as `--log-level debug` in the supervisor's CREATE-time argv (see
 * `container.ts`'s `buildOpenshellCreateArgv`), and the supervisor is pid 1
 * in that container — its log level cannot be hot-applied once running (see
 * the comment on session.ts's reattach path).
 *
 * `recordedAtCreate` is the ground truth from `SessionMeta.debugEgress` (set
 * by createSession going forward — see its doc comment): `true`/`false` is a
 * real, comparable measurement of what the running container actually booted
 * with; `undefined` means a legacy session created before this field
 * existed, i.e. genuinely unknown, NOT "false" (absent != false — the same
 * rule `buildInputsHash`'s absence already follows).
 *
 * Three outcomes:
 * - not requested: nothing to say, `null`.
 * - requested AND recorded === true: already satisfied — the container is
 *   already running at debug level, so reattaching changes nothing that
 *   needs reporting. Returning a warning here would itself be the exact
 *   false positive this function exists to prevent (confidently asserting
 *   "no debug lines" about a container that already has them).
 * - requested AND recorded === false: a confirmed, known mismatch — worded
 *   with the concrete, KNOWN consequence (no debug lines at all) rather than
 *   a generic "flag ignored". This is a diagnostic flag whose entire purpose
 *   is mid-incident investigation, and a misleading diagnostic (an empty
 *   debug capture silently misread as "cred_inject never fired") is worse
 *   than an absent one. See the colleague-401 incident this bd issue cites:
 *   59 HTTP POSTs and zero debug lines were misread as proof cred_inject
 *   aborted, when nothing had been instrumented at all.
 * - requested AND recorded === undefined: an UNKNOWN mismatch (legacy
 *   session) — hedged wording that states what we can't know rather than
 *   asserting the container has no debug lines, which we cannot actually
 *   confirm. Asserting a fact we don't have would be the same manufactured-
 *   evidence failure this whole fix is about, just relocated to the legacy
 *   case instead of eliminated.
 */
export function debugEgressReattachWarning(
  sessionName: string,
  requested: boolean,
  recordedAtCreate: boolean | undefined,
): string | null {
  if (!requested) return null;
  if (recordedAtCreate === true) return null;
  if (recordedAtCreate === false) {
    return (
      `openlock: --debug-egress requested, but sandbox "${sessionName}" was created WITHOUT it ` +
      "and is already running — the supervisor's log level is fixed at container CREATE time " +
      "and cannot be changed on a running sandbox, so its egress log will contain NO debug " +
      "lines. Re-run with --rebuild to recreate the sandbox at debug level."
    );
  }
  return (
    `openlock: --debug-egress requested, but sandbox "${sessionName}" is already running and ` +
    "openlock does not know whether it was created with debug logging (created before this was " +
    "tracked) — the supervisor's log level cannot be changed on a running sandbox regardless of " +
    "which it was. Unless it was created with --debug-egress, its egress log will contain no " +
    "debug lines. Re-run with --rebuild to recreate the sandbox at debug level and be sure."
  );
}

/**
 * Warning line when `--branch` is requested on a plain reattach (openlock-
 * tgfk "while there" finding — same silent-drop shape as debugEgress above,
 * and the same ground-truth-vs-legacy split). The workdir is git-cloned at a
 * specific branch only inside createSession's one-shot setup script (see
 * `buildSetupCmd`'s `branchFlag`); `reattachSession` takes no `branch`
 * parameter at all and never re-clones. By the time this runs,
 * `validateBranchFlagAgainstWorkdir` has already confirmed a git-bundle
 * workdir is declared (a non-git-bundle workdir or a missing one would have
 * exited the process before reaching the reattach path).
 *
 * `recordedAtCreate` is `SessionMeta.branch`: `null` means "created with no
 * --branch" (a real, comparable value — set explicitly by createSession,
 * never omitted, going forward); a string is the branch it was created with;
 * `undefined` means a legacy session created before this field existed —
 * genuinely unknown, not the same as `null`.
 *
 * Same three outcomes as `debugEgressReattachWarning`: not requested -> null;
 * requested and it matches what was recorded -> null (already satisfied,
 * nothing to report); requested and recorded is known and differs (including
 * recorded `null`, i.e. created with no branch at all) -> a confident warning
 * naming the real mismatch; requested and recorded is `undefined` (legacy) ->
 * a hedged warning that doesn't assert a fact we don't have.
 */
export function branchReattachWarning(
  sessionName: string,
  requested: string | undefined,
  recordedAtCreate: string | null | undefined,
): string | null {
  if (requested === undefined) return null;
  if (recordedAtCreate === requested) return null;
  if (recordedAtCreate !== undefined) {
    const createdWith =
      recordedAtCreate === null ? "without a --branch" : `with branch "${recordedAtCreate}"`;
    return (
      `openlock: --branch ${requested} requested, but sandbox "${sessionName}" was created ` +
      `${createdWith} and is already running — the workdir was already cloned at container ` +
      "CREATE time and cannot be switched to a different branch on a running sandbox. Re-run " +
      "with --rebuild to recreate the sandbox on that branch."
    );
  }
  return (
    `openlock: --branch ${requested} requested, but sandbox "${sessionName}" is already running ` +
    "and openlock does not know which branch it was created with (created before this was " +
    "tracked) — the workdir cannot be switched to a different branch on a running sandbox " +
    "regardless. Re-run with --rebuild to recreate the sandbox on that branch and be sure."
  );
}
