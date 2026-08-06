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
        if (existsSync(markerPath)) return { built: false };
        appendFileSync(logPath, `${runId} start\n`);
        let remaining = 0;
        if (existsSync(failuresRemainingPath)) {
          remaining = Number(readFileSync(failuresRemainingPath, "utf-8"));
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
