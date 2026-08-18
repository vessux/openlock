import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../paths";
import type { Harness } from "./harness";

export interface SessionMeta {
  id: string;
  name: string;
  repoPath: string;
  image: string;
  policy: string;
  createdAt: string;
  lastAttachedAt: string | null;
  attachedPid: number | null;
  harness: Harness;
  /** sha256 of the container's "cold" build inputs at create time
   * (Containerfile + mounts + policy content) — see sandbox/drift.ts. Used on
   * reattach to detect drift and offer a rebuild. Absent on sessions created
   * before drift-tracking existed (and on the `--policy` override path where
   * inputs can't be read); a missing value means "can't compare, don't prompt". */
  buildInputsHash?: string;
  /** Names of `credentials:` bundles actually attached to the sandbox's
   * SandboxSpec at CREATE time (openlock-04t) — providers attach only at
   * create, never on reattach, so this is the recorded ground truth reattach
   * compares the currently-declared bundle set against (see
   * sandbox/drift.ts findUnattachedCredentialBundles). Always set (even to
   * `[]`) by createSession going forward. Absent on sessions created before
   * this field existed — that means "unknown", NOT "nothing was attached":
   * treat it exactly like buildInputsHash's absence, i.e. can't compare, so
   * don't warn. A present-but-empty array means "genuinely nothing was
   * declared/attached at create time", which is a real, comparable value. */
  attachedCredentialBundles?: string[];
  /** Whether `--debug-egress` was passed at CREATE time (openlock-tgfk) — the
   * supervisor's log level is fixed for the container's lifetime, so this is
   * the recorded ground truth a later reattach compares a fresh
   * `--debug-egress` request against (see sandbox/drift.ts
   * debugEgressReattachWarning). Always set (even to `false`) by
   * createSession going forward — `false` is a real, comparable measurement
   * ("this container is definitely NOT running at debug level"), not the
   * same as absence. Absent on sessions created before this field existed:
   * that means "unknown", exactly like buildInputsHash's absence — can't
   * compare, so the warning must hedge rather than assert a fact we don't
   * have. */
  debugEgress?: boolean;
  /** The `--branch` value passed at CREATE time (openlock-tgfk), or `null` if
   * none was passed — the workdir is git-cloned at a branch only inside
   * createSession's one-shot setup script, so this is the recorded ground
   * truth a later reattach's `--branch` request is compared against (see
   * sandbox/drift.ts branchReattachWarning). Always set by createSession
   * going forward, using `null` (not omitting the key) for "created with no
   * --branch" — a real, comparable value distinct from the key being absent
   * entirely. Key absent means a session created before this field existed:
   * "unknown", exactly like buildInputsHash's absence — can't compare, so
   * the warning must hedge rather than assert a fact we don't have. */
  branch?: string | null;
}

// Legacy meta files (pre-slim-images) may carry extra fields like `caps` or
// `path`. Accept them on read and drop them silently. Pre-1.0; we don't
// promise on-disk back-compat beyond best-effort migration.
interface LegacyMeta extends Omit<SessionMeta, "repoPath" | "harness"> {
  repoPath?: string;
  path?: string;
  harness?: Harness;
  caps?: unknown;
}

function migrateMeta(raw: LegacyMeta): SessionMeta {
  const { caps: _caps, ...sansCaps } = raw;
  let withRepoPath: Omit<SessionMeta, "harness">;
  if (sansCaps.repoPath === undefined && typeof sansCaps.path === "string") {
    const { path, ...rest } = sansCaps;
    withRepoPath = { ...rest, repoPath: path };
  } else {
    const { path: _legacy, ...rest } = sansCaps;
    withRepoPath = rest as Omit<SessionMeta, "harness">;
  }
  return { ...withRepoPath, harness: sansCaps.harness ?? "claude_code" };
}

export function sessionsDir(): string {
  return join(resolveStateDir(), "sessions");
}

export function sessionDirById(baseDir: string, id: string): string {
  return join(baseDir, id);
}

export function saveSession(baseDir: string, meta: SessionMeta): void {
  const dir = sessionDirById(baseDir, meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function loadSession(baseDir: string, id: string): SessionMeta | null {
  const metaPath = join(sessionDirById(baseDir, id), "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return migrateMeta(JSON.parse(readFileSync(metaPath, "utf-8")) as LegacyMeta);
  } catch {
    return null;
  }
}

export function listAllSessions(baseDir: string): SessionMeta[] {
  if (!existsSync(baseDir)) return [];
  const out: SessionMeta[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = loadSession(baseDir, entry.name);
    if (meta !== null) out.push(meta);
  }
  return out;
}

export function findSessionsByPath(baseDir: string, repoPath: string): SessionMeta[] {
  return listAllSessions(baseDir).filter((m) => m.repoPath === repoPath);
}

export function removeSessionDir(baseDir: string, id: string): void {
  rmSync(sessionDirById(baseDir, id), { recursive: true, force: true });
}

export function updateSessionMeta(
  baseDir: string,
  id: string,
  patch: Partial<Omit<SessionMeta, "id">>,
): void {
  const cur = loadSession(baseDir, id);
  if (cur === null) throw new Error(`session not found: ${id}`);
  const next = { ...cur, ...patch };
  saveSession(baseDir, next);
}
