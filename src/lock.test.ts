import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockTimeoutError, withLock } from "./lock";

const SMOKE_PATH = join(import.meta.dir, "_lock-smoke.ts");

let workDir: string;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function freshWorkDir(): string {
  workDir = mkdtempSync(join(tmpdir(), "openlock-lock-test-"));
  return workDir;
}

interface ContenderResult {
  ok: boolean;
  result?: { built: boolean };
  error?: string;
}

/** Runs `_lock-smoke.ts` in "contender" mode as a real, separate OS process
 * — see that file's header for why this has to be a subprocess rather than
 * two promises in this test's own runtime. */
async function runContender(
  dir: string,
  runId: string,
  failuresRemaining?: number,
): Promise<ContenderResult> {
  const failuresRemainingPath = join(dir, "failures-remaining");
  if (failuresRemaining !== undefined) {
    writeFileSync(failuresRemainingPath, String(failuresRemaining));
  }
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      SMOKE_PATH,
      "contender",
      join(dir, "lock"),
      join(dir, "log"),
      join(dir, "marker"),
      failuresRemainingPath,
      runId,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENLOCK_LOCK_SMOKE: "1" },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`contender ${runId} exited ${code}: ${stderr}`);
  return JSON.parse(stdout.trim());
}

function readLog(dir: string): string[] {
  const p = join(dir, "log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
}

describe("withLock (openlock-jyk) — cross-process", () => {
  it("(a) two contending processes: exactly one does the work, the other observes the completed result", async () => {
    const dir = freshWorkDir();
    const [a, b] = await Promise.all([runContender(dir, "a"), runContender(dir, "b")]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Exactly one of the two actually built; the other's locked re-check saw
    // the marker the first one wrote and skipped straight to built:false.
    const builtCount = [a.result?.built, b.result?.built].filter((v) => v === true).length;
    expect(builtCount).toBe(1);
    const log = readLog(dir);
    expect(log.filter((l) => l.endsWith(" start"))).toHaveLength(1);
    expect(log.filter((l) => l.endsWith(" built"))).toHaveLength(1);
  });

  it("(b) leader fails: the failure is NOT cached — the waiter retries its own check-then-build and succeeds", async () => {
    const dir = freshWorkDir();
    // failuresRemaining=1: whichever contender's closure runs FIRST (i.e.
    // wins the lock) hits it, decrements to 0, and throws. The one that
    // acquires the lock SECOND (only possible once the first releases on
    // failure) sees remaining=0 and succeeds. This is deterministic
    // regardless of which real process wins the race, because withLock
    // strictly serializes entry into the closure.
    const [a, b] = await Promise.all([runContender(dir, "a", 1), runContender(dir, "b", 1)]);
    const results = [a, b];
    const failed = results.filter((r) => !r.ok);
    const succeeded = results.filter((r) => r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatch(/simulated build failure/);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.result?.built).toBe(true);
    // Both independently attempted the check-then-build closure — the
    // waiter did not inherit the leader's failure or skip its own attempt.
    const log = readLog(dir);
    expect(log.filter((l) => l.endsWith(" start"))).toHaveLength(2);
    expect(log.filter((l) => l.endsWith(" fail"))).toHaveLength(1);
    expect(log.filter((l) => l.endsWith(" built"))).toHaveLength(1);
  });

  it("(c) a lock left by a killed (dead) process is reclaimed, not deadlocked", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    const readyPath = join(dir, "ready");

    const holder = Bun.spawn({
      cmd: ["bun", "run", SMOKE_PATH, "holder", lockPath, readyPath],
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, OPENLOCK_LOCK_SMOKE: "1" },
    });

    // Bounded poll for the holder to actually hold the lock (small, capped
    // real waits for process-startup synchronization — not an assertion on
    // elapsed time; see the file header note on why this differs from the
    // wall-clock assertions openlock-ur15 removed).
    const deadline = Date.now() + 5000;
    while (!existsSync(readyPath)) {
      if (Date.now() > deadline) throw new Error("holder never signaled readiness");
      await Bun.sleep(10);
    }
    expect(existsSync(lockPath)).toBe(true);

    holder.kill("SIGKILL");
    await holder.exited; // reaped: the PID is now genuinely dead

    // Recover via a normal contender, with the DEFAULT (generous) staleMs —
    // proving reclaim happens via the PID-liveness check (immediate), not
    // the age-based fallback (which would need the lock to sit for
    // `staleMs`, minutes by default, and this test would time out at its
    // own 3s budget well before that).
    const result = await runContender(dir, "recoverer");
    expect(result.ok).toBe(true);
    expect(result.result?.built).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("withLock (openlock-jyk) — same-process", () => {
  it("(d) releases the lock file on the happy path", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    const result = await withLock(lockPath, async () => "ok");
    expect(result).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when fn throws (so a waiter is never left blocked by a failed leader)", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    await expect(
      withLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  // openlock-ur15 pattern (container.ts's WaitForSandboxReadyOpts): an
  // injectable now/sleep seam so a genuinely-contended-and-never-released
  // lock can be proven to time out without any real waiting. Both halves of
  // the seam matter — a sleep-only fake would leave `deadline` on the real
  // clock and busy-spin for the real timeoutMs.
  it("throws LockTimeoutError against a live (non-stale) holder, using a fake clock — no real waiting", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    // Simulate an already-held, non-stale lock: our own PID is alive, and a
    // fresh lock file is never stale by age.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "someone-else" }));

    let virtualNow = 0;
    const sleeps: number[] = [];
    const now = () => virtualNow;
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      virtualNow += ms;
    };

    await expect(
      withLock(lockPath, async () => "should never run", {
        timeoutMs: 500,
        retryMs: 50,
        now,
        sleep,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    // Resolved purely through the fake clock: exactly enough sleeps to
    // cross the 500ms budget in 50ms steps, zero real elapsed time.
    expect(sleeps.length).toBeGreaterThanOrEqual(10);
    expect(sleeps.every((ms) => ms === 50)).toBe(true);
  });

  it("force-reclaims a lock whose holder PID is alive but whose age exceeds staleMs (fallback path)", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    // A live PID (ours) but backdated far into the past — exercises the
    // age-based OR-branch of isLockStale directly, without needing to wait
    // any real time or kill any real process.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    const result = await withLock(lockPath, async () => "reclaimed", { staleMs: 1000 });
    expect(result).toBe("reclaimed");
    expect(existsSync(lockPath)).toBe(false);
  });
});

// Regression coverage for the write-then-link fix: an earlier `tryCreateLock`
// did `open(path, "wx")` (create EMPTY) then `writeSync` the content, which
// left a real window where `lockPath` existed but was unreadable — and the
// old "unreadable => instantly stale" rule let a second acquirer steal and
// recreate the file while the first was still mid-write, so BOTH believed
// they held the lock. These tests hand-craft that exact observable state
// (an empty file at lockPath) deterministically, with no attempt to hit the
// actual microsecond race, and assert the new rule no longer falls for it.
describe("withLock (openlock-jyk) — atomic publish (write-then-link)", () => {
  it("does not instantly steal a hand-created empty (unreadable) lock file", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    // Simulates the exact window the old open-then-write shape could leave
    // behind: lockPath exists, but has no parseable {pid, token} yet.
    writeFileSync(lockPath, "");

    let virtualNow = 0;
    const sleeps: number[] = [];
    const now = () => virtualNow;
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      virtualNow += ms;
    };

    await expect(
      withLock(lockPath, async () => "should never run", {
        timeoutMs: 200,
        retryMs: 50,
        staleMs: 10_000, // real elapsed time in this test is a few ms — nowhere near this
        now,
        sleep,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    // It backed off and waited out the full (fake) budget rather than
    // reclaiming the empty file on the very first check.
    expect(sleeps.length).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(true);
    const raw = readFileSync(lockPath, "utf-8");
    expect(raw).toBe(""); // untouched — nobody stole it
  });

  it("still eventually reclaims a persistently-unreadable lock file once its age exceeds staleMs (not blocked forever)", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    writeFileSync(lockPath, "");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    const result = await withLock(lockPath, async () => "reclaimed", { staleMs: 1000 });
    expect(result).toBe("reclaimed");
  });

  it("publishes fully-formed, readable {pid, token} content — never an empty file — and leaves no temp file behind", async () => {
    const dir = freshWorkDir();
    const lockPath = join(dir, "lock");
    await withLock(lockPath, async () => {
      const raw = readFileSync(lockPath, "utf-8");
      expect(raw.length).toBeGreaterThan(0);
      const parsed = JSON.parse(raw);
      expect(parsed.pid).toBe(process.pid);
      expect(typeof parsed.token).toBe("string");
      return null;
    });
    expect(existsSync(lockPath)).toBe(false); // released
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
