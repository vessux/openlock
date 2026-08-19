import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// openlock-u7ca: this spawn runs through cli.ts's real main(), which now
// calls announceBaseImageChangeIfNeeded() before --print-base-tag's own
// short-circuit — that function reads/writes a marker file under the
// resolved state dir on every invocation. Without OPENLOCK_STATE_DIR this
// spawn previously fell through to the developer's REAL default state dir
// (~/.local/state/openlock), which is exactly the synthetic-state-only rule
// this project was burned into adopting (feedback_tests_synthetic_state_only.md).
// Cleanup lives in afterEach, not a trailing/try-finally statement, because a
// bun test timeout skips an in-body finally but still runs afterEach.

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "openlock-printbasetag-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("openlock --print-base-tag", () => {
  it("prints a ghcr-qualified base tag and exits 0", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "--print-base-tag"], {
      env: { ...process.env, OPENLOCK_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^ghcr\.io\/vessux\/openlock-base:[0-9a-f]{12}$/);
  });
});
