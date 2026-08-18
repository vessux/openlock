import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// openlock-u7ca: see print-base-tag.test.ts's header comment — this spawn
// runs through cli.ts's real main(), which now touches the resolved state
// dir on every invocation via announceBaseImageChangeIfNeeded(). Without
// OPENLOCK_STATE_DIR this previously fell through to the developer's real
// default state dir.

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "openlock-pruneimages-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("pruneImagesCmd dry-run", () => {
  it("exits 0 in dry-run mode", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "prune-images", "--dry-run"], {
      env: { ...process.env, OPENLOCK_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
