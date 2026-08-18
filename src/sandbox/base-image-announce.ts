import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../paths";
import { computeBaseTag, detectBaseImageDrift, GHCR_BASE_PREFIX } from "./ensure-base";
import { BASE_CONTAINERFILE } from "./image-build";
import { listAllSessions, sessionsDir } from "./session-store";

/**
 * openlock-u7ca: announce a base-image change at the moment it's discoverable
 * (a fresh `openlock` invocation after an upgrade), instead of leaving it to
 * the reactive, per-project `openlock doctor`/sandbox-preflight warning
 * (`ensure-base.ts`'s `detectBaseImageDrift`, wired in `doctor.ts`), which
 * only fires for a project the user happens to revisit — "possibly weeks
 * later, possibly never for one they have parked" per the ticket.
 *
 * Mechanism: a flat single-value marker file under the state dir, following
 * the exact idiom `sandbox/ensure-gateway.ts` already established for
 * `gateway.pid`/`gateway.port`/`gateway.driver` — read-compare-write on every
 * invocation, routed through `resolveStateDir()` (never a second inline
 * HOME-relative computation — see that function's own doc comment on the
 * split-surface bug this project has hit before).
 *
 * Deliberately NOT install.sh-only: a `bun link` dev install bypasses
 * install.sh entirely, so only a check inside the CLI itself (called from
 * `main()` in `cli.ts`, before any command dispatch) covers every install
 * method. It is also deliberately NOT gated behind `doctor`/preflight — this
 * is the same "the information exists, the surface that would show it never
 * runs" defect family the ticket names, and doctor/preflight are exactly the
 * on-demand surfaces already shown insufficient. Because it runs
 * unconditionally on every invocation rather than only once ever, a missed
 * window (process killed mid-check) just means it fires on the next
 * invocation instead of never — unlike a true first-run-only probe.
 */

// Not exported: nothing outside this module needs the marker's on-disk
// location or raw read/write — the pure classify/render/enumerate functions
// below are the tested surface, and the orchestrator at the bottom of this
// file is the only caller. The end-to-end CLI test covers the read/write
// side effects by asserting against the same literal filename directly.
const BASE_TAG_MARKER_FILENAME = "base-tag.seen";

function baseTagMarkerFile(stateDir: string): string {
  return join(stateDir, BASE_TAG_MARKER_FILENAME);
}

function isValidBaseTag(raw: string): boolean {
  return new RegExp(
    `^${GHCR_BASE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{12}$`,
  ).test(raw);
}

/**
 * Reads the marker file's raw (trimmed) content, or `null` when the file
 * doesn't exist (or can't be read at all — treated the same as absent,
 * matching `ensure-gateway.ts`'s `readGatewayPortRecord` catch-all
 * convention). Deliberately distinct from "present but empty/garbage",
 * which returns a non-null string here so `classifyBaseTagChange` can tell
 * "no record" from "a malformed record" instead of collapsing both into the
 * same case — this project's standing "absent != equal" rule extends to
 * "absent != malformed" too.
 */
function readBaseTagMarkerRaw(stateDir: string): string | null {
  try {
    return readFileSync(baseTagMarkerFile(stateDir), "utf-8").trim();
  } catch {
    return null;
  }
}

function writeBaseTagMarker(stateDir: string, tag: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(baseTagMarkerFile(stateDir), tag);
}

/**
 * Whether this state dir shows ANY sign of prior openlock use, independent
 * of the base-tag marker itself. Needed to resolve the ambiguity a marker
 * file alone can't: "no marker" means either a genuinely fresh install (no
 * prior base image was ever in play — correct to stay silent) or an upgrade
 * from a binary that predates this feature (a real prior base WAS in play,
 * just never recorded — silence there would be exactly the "absent == no
 * change" false claim this project's standing rule forbids).
 *
 * Signals chosen are the ones already written by unrelated, pre-existing
 * code the moment openlock does anything beyond a bare install:
 * `sessions/` gains an entry the first time a sandbox is ever created
 * (`session-store.ts`'s `saveSession`), and `gateway.pid`/`gateway.port`/
 * `gateway.driver` are written the moment a gateway first starts
 * (`ensure-gateway.ts`'s `startGateway`). A user who has done neither is
 * genuinely indistinguishable from a fresh install for this purpose, so "no
 * marker AND none of these" is the only combination classified as fresh.
 */
export function hasPriorOpenlockState(stateDir: string): boolean {
  if (existsSync(join(stateDir, "gateway.pid"))) return true;
  if (existsSync(join(stateDir, "gateway.port"))) return true;
  if (existsSync(join(stateDir, "gateway.driver"))) return true;
  try {
    return readdirSync(join(stateDir, "sessions")).length > 0;
  } catch {
    return false;
  }
}

export type BaseTagAnnounceResult =
  | { kind: "fresh" }
  | { kind: "match" }
  | { kind: "unknown-prior" }
  | { kind: "unparseable" }
  | { kind: "changed"; oldTag: string; newTag: string };

/**
 * Pure classification — no fs, no fs paths, easy to exhaustively unit test.
 * `recordedRaw` is exactly `readBaseTagMarkerRaw`'s return shape: `null` for
 * "no marker file", any string (including `""`) for "marker file exists
 * with this trimmed content".
 */
export function classifyBaseTagChange(
  recordedRaw: string | null,
  currentTag: string,
  priorStateExists: boolean,
): BaseTagAnnounceResult {
  if (recordedRaw === null) {
    return priorStateExists ? { kind: "unknown-prior" } : { kind: "fresh" };
  }
  if (!isValidBaseTag(recordedRaw)) return { kind: "unparseable" };
  if (recordedRaw === currentTag) return { kind: "match" };
  return { kind: "changed", oldTag: recordedRaw, newTag: currentTag };
}

export interface AffectedProjectsResult {
  affected: string[];
  skipped: string[];
}

/**
 * Part B: which recorded project paths are still pinned to a stale base.
 * Pure and podman/registry-free — `detectBaseImageDrift` is exactly the same
 * pure comparison `doctor.ts`'s `buildBaseImageDriftCheck` already runs per
 * project, just fanned out over every path the session store knows about
 * instead of only `process.cwd()`.
 *
 * Dedupes by `repoPath` internally (multiple sessions commonly share one
 * project dir) so a caller can pass the raw, undeduplicated list straight
 * from `listAllSessions`.
 *
 * Never throws. A path whose `.openlock/Containerfile` can't be read at all
 * (deleted, moved, permissions) is counted in `skipped` rather than silently
 * dropped — silently dropping a moved-but-still-affected project is the
 * exact defect family this ticket exists to fix. A path whose Containerfile
 * IS readable but resolves to `"match"`/`"custom"`/`"unparseable"` (per
 * `detectBaseImageDrift`) is a legitimate "checked, nothing to report"
 * outcome — mirrors `buildBaseImageDriftCheck`'s own `ok:true` treatment of
 * those same kinds for the single-project case — so it lands in neither
 * list.
 *
 * KNOWN LIMITATION, not solved here: a project that was `openlock init`ed
 * but never had a sandbox created is invisible to the session store, so it
 * can never appear in either list. There is no read path from a bare
 * `.openlock/` directory back to "projects that exist" — only sessions are
 * recorded.
 */
export function findAffectedProjects(
  repoPaths: string[],
  currentBaseContent: string,
  readContainerfile: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): AffectedProjectsResult {
  const affected: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const repoPath of repoPaths) {
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    const cfPath = join(repoPath, ".openlock", "Containerfile");
    let content: string;
    try {
      content = readContainerfile(cfPath);
    } catch {
      skipped.push(repoPath);
      continue;
    }
    const status = detectBaseImageDrift(content, currentBaseContent);
    if (status.kind === "drift") affected.push(repoPath);
  }
  return { affected, skipped };
}

/**
 * Renders the exact lines to print for a given classification (empty array
 * = print nothing). `affected` is only consulted for `"changed"` — Part B
 * enumeration is real work (a filesystem read per known project) that has no
 * reason to run for `"fresh"`/`"match"`/`"unknown-prior"`/`"unparseable"`.
 */
export function renderBaseTagAnnouncement(
  result: BaseTagAnnounceResult,
  affected: AffectedProjectsResult | null,
): string[] {
  switch (result.kind) {
    case "fresh":
    case "match":
      return [];
    case "unknown-prior":
    case "unparseable":
      return [
        "openlock: could not determine this installation's previously recorded base image " +
          "(no usable record) — if a base-image fix shipped recently, some projects may still " +
          "be silently pinned to a stale base. Run `openlock doctor` inside a project, or " +
          "`openlock update-base --project <dir>` to update proactively.",
      ];
    case "changed": {
      const lines = [
        `openlock: base image changed since last run (${result.oldTag} -> ${result.newTag}).`,
      ];
      if (affected && affected.affected.length > 0) {
        lines.push(
          `openlock: ${affected.affected.length} project(s) are still pinned to the old base ` +
            `and will NOT get this update automatically: ${affected.affected.join(", ")}. Run ` +
            "`openlock update-base --project <dir>` for each, then rebuild.",
        );
      }
      if (affected && affected.skipped.length > 0) {
        lines.push(
          `openlock: ${affected.skipped.length} known project path(s) could not be checked ` +
            `(missing or unreadable): ${affected.skipped.join(", ")}.`,
        );
      }
      return lines;
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/**
 * Orchestrator — called once at the top of `main()` in `cli.ts`, before any
 * command dispatch. Synchronous and cheap: `computeBaseTag` is a local
 * sha256 (no registry/podman call), and Part B enumeration only runs at all
 * on the rare `"changed"` branch, never on the common `"match"` steady
 * state. Wrapped so it can NEVER throw — this is a best-effort diagnostic,
 * and an upgrade notice must not be able to break normal CLI dispatch.
 */
export function announceBaseImageChangeIfNeeded(): void {
  try {
    const stateDir = resolveStateDir();
    const currentTag = computeBaseTag(BASE_CONTAINERFILE);
    const recordedRaw = readBaseTagMarkerRaw(stateDir);
    const priorState = hasPriorOpenlockState(stateDir);
    const result = classifyBaseTagChange(recordedRaw, currentTag, priorState);

    if (result.kind === "match") return; // common case: no write, no output.

    let affected: AffectedProjectsResult | null = null;
    if (result.kind === "changed") {
      const repoPaths = listAllSessions(sessionsDir()).map((m) => m.repoPath);
      affected = findAffectedProjects(repoPaths, BASE_CONTAINERFILE);
    }

    for (const line of renderBaseTagAnnouncement(result, affected)) console.error(line);
    writeBaseTagMarker(stateDir, currentTag);
  } catch {
    // Best-effort diagnostic only — never let it break CLI dispatch.
  }
}
