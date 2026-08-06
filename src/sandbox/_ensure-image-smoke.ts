#!/usr/bin/env bun
// Test-only fixture (bd openlock-jyk): drives the real `ensureImage` from a
// genuinely separate OS process — the exact shape of the bug report (two
// separate `openlock` CLI invocations), which `image-build-lock.test.ts`
// cannot reproduce with two promises in one runtime. Same convention as
// src/cli/_picker-smoke.ts and src/_lock-smoke.ts: guarded by an env var so
// it can't run by accident, and excluded from knip's unused-export scan via
// knip.json's `ignore`.
import { ensureImage } from "./image-build";

if (process.env.OPENLOCK_LOCK_SMOKE !== "1") {
  console.error("This file is a test fixture; set OPENLOCK_LOCK_SMOKE=1");
  process.exit(2);
}

const [, , containerfileContent, tagPrefix] = process.argv;

try {
  const result = await ensureImage({ containerfileContent, tagPrefix });
  console.log(JSON.stringify({ ok: true, result }));
} catch (err) {
  console.log(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
}
