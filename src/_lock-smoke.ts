#!/usr/bin/env bun
// Test-only fixture (bd openlock-jyk): drives the real `withLock` from a
// genuinely separate OS process, the same shape as src/cli/_picker-smoke.ts
// for the picker. `lock.test.ts`'s cross-process coverage needs actual
// process boundaries — two promises in one runtime would never exercise the
// O_EXCL lockfile contention this primitive exists for. Not part of the
// public CLI: guarded by OPENLOCK_LOCK_SMOKE so it can't run by accident,
// and excluded from knip's unused-export scan via knip.json's `ignore`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { withLock } from "./lock";

if (process.env.OPENLOCK_LOCK_SMOKE !== "1") {
  console.error("This file is a test fixture; set OPENLOCK_LOCK_SMOKE=1");
  process.exit(2);
}

const [, , mode, lockPath, ...rest] = process.argv;

if (mode === "holder") {
  // Acquires the lock, signals readiness, then never releases it — the test
  // SIGKILLs this process to produce a genuinely stale (dead-holder) lock.
  const [readyPath] = rest;
  await withLock(lockPath, async () => {
    writeFileSync(readyPath, "1");
    await new Promise<never>(() => {});
  });
} else if (mode === "contender") {
  // check-then-act, the same shape ensureImage's locked closure uses: verify
  // the work isn't already done, do it, optionally fail N times first (via
  // failuresRemainingPath) to simulate a build that fails before it
  // eventually succeeds.
  const [logPath, markerPath, failuresRemainingPath, runId] = rest;
  try {
    const result = await withLock(
      lockPath,
      async () => {
        // DELIBERATELY NON-ATOMIC, and load-bearing — do NOT "fix" this into an
        // O_EXCL create-if-absent (which is what CodeQL's js/file-system-race
        // remediation advice would have you do here). This check-then-act IS
        // the race `withLock` exists to serialize, and the test's power depends
        // on it staying racy: lock.test.ts case (a) asserts exactly ONE
        // `" start"` line, and `start` is logged below only AFTER this check
        // passes. With a genuinely atomic marker, a broken/no-op `withLock`
        // would still yield one `start` (the loser would EEXIST out before
        // logging) and the test would pass while proving nothing. Racy, both
        // processes see no marker, both log `start`, and the assertion fails —
        // which is the whole point. Safe because this is a test-only fixture
        // writing into a per-test tmpdir with no untrusted input.
        if (existsSync(markerPath)) return { built: false };
        appendFileSync(logPath, `${runId} start\n`);
        // The failure counter, by contrast, has no such requirement — read it
        // by fd/exception rather than existsSync-then-read, so it doesn't add a
        // second, gratuitous check-then-act to the file above.
        let remaining = 0;
        try {
          remaining = Number(readFileSync(failuresRemainingPath, "utf-8"));
        } catch {
          remaining = 0; // absent counter ⇒ no simulated failures requested
        }
        if (remaining > 0) {
          writeFileSync(failuresRemainingPath, String(remaining - 1));
          appendFileSync(logPath, `${runId} fail\n`);
          throw new Error("simulated build failure");
        }
        writeFileSync(markerPath, runId);
        appendFileSync(logPath, `${runId} built\n`);
        return { built: true };
      },
      { timeoutMs: 3000, retryMs: 20 },
    );
    console.log(JSON.stringify({ ok: true, result }));
  } catch (err) {
    console.log(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
