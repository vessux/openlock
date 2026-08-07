import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * openlock-jyk: a genuinely cross-PROCESS mutual-exclusion primitive, backed
 * by an O_EXCL lockfile rather than an in-process mutex/memoization — the
 * motivating case is two separate `openlock` CLI invocations (separate OS
 * processes, no shared memory an in-process guard could see).
 *
 * Checked before settling on this shape: Bun/node:fs expose no flock(2)
 * binding (`Object.keys(require("node:fs")).filter(k =>
 * k.toLowerCase().includes("lock"))` is empty on this repo's Bun 1.3.14 /
 * node:fs types, and `typeof require("node:fs").flock` is `"undefined"`).
 * An atomic create-if-absent file is the pragmatic substitute: write the
 * full `{pid, token}` contents to a private temp file, then `link(2)` it
 * into place at `lockPath` — link fails with `EEXIST` if the target already
 * exists, so it's both the exclusive create AND guarantees the content is
 * complete the instant the file becomes visible (see `tryCreateLock`'s doc
 * for why that matters — an earlier open-empty-then-write shape had a real
 * race here). Every other acquirer that hits `EEXIST` must wait or reclaim
 * the lock as stale (see `isLockStale` below).
 *
 * General enough to reuse for openlock-ci7's credential/global-config
 * writes (a different call site, same missing primitive) — ci7's call sites
 * are out of scope here. This change wires it into the two `openlock
 * sandbox` production build sites (`ensureBase`, and `ensureSandbox`'s
 * user-tag build) plus `ensureImage`, which has no production caller but is
 * contended by the integration suite.
 */

export interface WithLockOpts {
  /** Total budget to wait for a held, non-stale lock before giving up. */
  timeoutMs?: number;
  /** Delay between acquire attempts while backing off. */
  retryMs?: number;
  /**
   * How stale (real ms) a lock may get before being force-reclaimed even
   * though its recorded holder PID still resolves to a *live* process — see
   * the race-window note on `isLockStale`. Defaults generously high because
   * the PID-liveness check is the primary, fast path for the common case
   * (the holder crashed/was SIGKILLed); this age check is only the
   * fallback net for when that check itself can't be trusted.
   */
  staleMs?: number;
  // Test seam (openlock-ur15 pattern, see container.ts's
  // WaitForSandboxReadyOpts): defaults to the real Date.now/Bun.sleep so
  // production behavior is unchanged. Governs the acquire retry/backoff
  // loop only — NOT the stale-lock age check, which is deliberately always
  // judged against the real clock (see `isLockStale`'s doc).
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`gave up waiting for lock ${lockPath} after ${timeoutMs}ms`);
    this.name = "LockTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // an image build can legitimately take minutes
const DEFAULT_RETRY_MS = 200;
const DEFAULT_STALE_MS = 15 * 60 * 1000;

interface LockFileContents {
  pid: number;
  token: string;
}

function parseLockFile(raw: string): LockFileContents | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockFileContents).pid === "number" &&
      typeof (parsed as LockFileContents).token === "string"
    ) {
      return parsed as LockFileContents;
    }
  } catch {
    // fall through — corrupt/partial content, treated as unreadable below
  }
  return undefined;
}

/** Reads back a lock file's contents + its real-clock age. `undefined` means
 * "gone" (ENOENT) — always a race with a concurrent release/reclaim, never
 * an error. */
function readLockFile(
  lockPath: string,
): { contents: LockFileContents | undefined; ageMs: number } | undefined {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, "utf-8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return { contents: parseLockFile(raw), ageMs: Date.now() - mtimeMs };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to another user — still alive.
    // Anything else (most commonly ESRCH) means it's gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when the lock at `lockPath` should be force-reclaimed rather than
 * waited on.
 *
 * RACE WINDOW (documented, not eliminated): the OS can reuse a dead
 * process's PID for a brand-new, unrelated process before this check runs.
 * When that happens, `isPidAlive` reports "alive" even though the original
 * holder is long gone, and this function falls through to the `ageMs`
 * fallback — so a PID-reuse false negative is bounded by `staleMs`, not
 * permanent. The inverse risk of that fallback is real too: a genuinely
 * slow, still-alive, still-building holder that exceeds `staleMs` CAN be
 * wrongly reclaimed. That failure mode is a second concurrent build — the
 * same waste this primitive exists to avoid in the common case, not data
 * loss or corruption — which is why `DEFAULT_STALE_MS` is generous rather
 * than tuned tight.
 *
 * Unreadable/corrupt content (`read.contents === undefined`) is treated the
 * SAME as an alive-but-old holder — age-gated, not instantly stolen. Post
 * the `tryCreateLock` fix below, our own writer can never publish a lock
 * file whose content isn't already a complete, parseable `{pid, token}` (it
 * writes the full content to a private temp file and only then atomically
 * links it into place), so anything unreadable at `lockPath` is foreign —
 * some other tool, a leftover from a different lock implementation, or a
 * genuinely torn write on a filesystem this code doesn't control. Gating it
 * on `staleMs` rather than reclaiming it on sight means a transient/foreign
 * write-in-progress this code can't see isn't punished immediately, while
 * still guaranteeing it's eventually reclaimed rather than blocking forever.
 */
function isLockStale(lockPath: string, staleMs: number): boolean {
  const read = readLockFile(lockPath);
  if (read === undefined) return true; // already gone; next open() settles the race
  if (read.contents === undefined) return read.ageMs > staleMs; // foreign/corrupt — bounded, not instant
  if (!isPidAlive(read.contents.pid)) return true;
  return read.ageMs > staleMs;
}

/**
 * Atomically publishes `{pid, token}` at `lockPath`, or fails (returns
 * false) if someone else already holds it.
 *
 * Writes the FULL contents to a private temp path first, then `linkSync`s
 * it into place: `link(2)` is the atomic create-if-absent primitive (EEXIST
 * if the target already exists), and by the time it succeeds the content is
 * already durable — there is no window where `lockPath` exists but is still
 * empty. An earlier version of this function did
 * `openSync(lockPath, "wx")` (create empty) THEN `writeSync` the content;
 * that left exactly that window, during which a concurrent reader saw the
 * file present-but-unparseable and (under the old, instant-reclaim
 * unreadable-content rule) deleted and recreated it out from under the
 * still-writing owner — real, verified: two acquirers could both believe
 * they held the lock. `linkSync` closes it by construction rather than by
 * timing.
 */
function tryCreateLock(lockPath: string, token: string): boolean {
  const tmpPath = `${lockPath}.${token}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, token } satisfies LockFileContents));
  try {
    linkSync(tmpPath, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    // linkSync leaves tmpPath as a second directory entry for the same
    // inode on success; removing it here only drops that entry, not the
    // (now lockPath-reachable) content. On failure it's just our own
    // never-published scratch file.
    removeIfPresent(tmpPath);
  }
}

function removeIfPresent(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Releases the lock only if it still holds OUR token — i.e. nobody reclaimed
 * it as stale out from under us. Without this check, a holder whose lock got
 * (wrongly) reclaimed via the `staleMs` fallback above would, on finishing,
 * delete whatever the NEW legitimate holder had since created. */
function releaseIfOwned(lockPath: string, token: string): void {
  const read = readLockFile(lockPath);
  if (read?.contents?.token !== token) return;
  removeIfPresent(lockPath);
}

/**
 * Runs `fn` while holding an exclusive, cross-process lock at `lockPath`.
 *
 * `fn` is re-entered independently by every caller that ever acquires the
 * lock — a caller whose `fn` throws simply releases the lock and rejects;
 * it is NOT cached or replayed for the next acquirer. Callers that want
 * "don't redo work someone else already finished" must make `fn` itself
 * check-then-act (re-verify the work isn't already done as its first
 * step) — see `ensureBase` for the reference shape. This is deliberate:
 * openlock-jyk's motivating bug report documents that a later independent
 * attempt currently rescues an earlier failed build, and caching failure
 * here would silently remove that.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: WithLockOpts = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryMs = DEFAULT_RETRY_MS,
    staleMs = DEFAULT_STALE_MS,
    now = Date.now,
    sleep = Bun.sleep,
  } = opts;

  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const deadline = now() + timeoutMs;

  for (;;) {
    if (tryCreateLock(lockPath, token)) break;
    if (isLockStale(lockPath, staleMs)) {
      // Reclaim and retry immediately (no backoff/deadline consumed) — if
      // another reclaimer wins the race, our next tryCreateLock just sees a
      // fresh, non-stale lock and falls through to the normal wait below.
      removeIfPresent(lockPath);
      continue;
    }
    if (now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
    await sleep(retryMs);
  }

  try {
    return await fn();
  } finally {
    releaseIfOwned(lockPath, token);
  }
}
