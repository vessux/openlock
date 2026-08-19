import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { computeBaseTag } from "../sandbox/ensure-base";
import { BASE_CONTAINERFILE } from "../sandbox/image-build";

// openlock-u7ca: end-to-end coverage of announceBaseImageChangeIfNeeded's
// wiring through `openlock`'s actual entry point (cli.ts's main()), using
// `--version` as the fastest global flag that still runs through main()'s
// top-of-function check before its own short-circuit. OPENLOCK_STATE_DIR
// points every invocation at a fresh scratch dir per test — never the real
// state dir (see feedback_tests_synthetic_state_only.md).

/**
 * The REAL, on-disk marker path this test must NEVER write to — independently
 * re-derived here (duplicated, not imported from paths.ts's
 * resolveStateDir/defaultStateDir) so a bug in THAT resolution can't fool
 * this oracle into reporting "unchanged" when it isn't. Mirrors
 * tests/integration/gateway-foreign-refusal.test.ts's
 * realGatewayRegistryMetadataPath in spirit: a hard, loud failure the moment
 * isolation stops being true, instead of a silent write to the developer's
 * real state dir (openlock-u7ca's own test suite did exactly this once —
 * see the four sibling CLI-spawn test files retrofitted alongside this one).
 * Read via `process.env.HOME`/`homedir()` directly — this file only ever
 * overrides `OPENLOCK_STATE_DIR` in a spawned CHILD's env, never the parent
 * test process's own `process.env.HOME`, so this always resolves the one
 * true default regardless of test ordering.
 */
function realBaseTagMarkerPath(): string {
  return join(process.env.HOME || homedir(), ".local", "state", "openlock", "base-tag.seen");
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

let stateDir: string;
let realMarkerBefore: string | null;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "openlock-base-announce-"));
  // Captured before this test's spawns run — read-only, never written to or
  // deleted by this suite (see the doc comment on realBaseTagMarkerPath).
  realMarkerBefore = readFileOrNull(realBaseTagMarkerPath());
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  // Regression guard: if a future change loses the OPENLOCK_STATE_DIR
  // isolation above, this fails loudly instead of quietly writing the
  // developer's real state again. Byte-identical comparison, including the
  // "still absent" case (both null) — never asserts a specific value, only
  // that this suite didn't change it.
  expect(readFileOrNull(realBaseTagMarkerPath())).toBe(realMarkerBefore);
});

function runCli(args: string[]) {
  return Bun.spawn({
    cmd: ["bun", "src/cli.ts", ...args],
    env: { ...process.env, OPENLOCK_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = runCli(args);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const currentTag = computeBaseTag(BASE_CONTAINERFILE);
// Guaranteed to differ from currentTag while remaining a valid-shaped tag —
// flips the final hex digit rather than hardcoding an unrelated hash, so
// this can never accidentally collide with whatever base.Containerfile
// happens to hash to today.
const staleTag = currentTag.slice(0, -1) + (currentTag.endsWith("0") ? "1" : "0");

function markerPath(): string {
  return join(stateDir, "base-tag.seen");
}

describe("announceBaseImageChangeIfNeeded wiring through cli.ts main() (openlock-u7ca)", () => {
  it("fresh state dir: prints nothing and writes the marker", async () => {
    const { code, stderr } = await run(["--version"]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("openlock: base image changed");
    expect(stderr).not.toContain("could not determine");
    expect(readFileSync(markerPath(), "utf-8").trim()).toBe(currentTag);
  });

  it("second invocation with a matching marker: stays silent", async () => {
    await run(["--version"]);
    const { stderr } = await run(["--version"]);
    expect(stderr).not.toContain("openlock: base image changed");
    expect(stderr).not.toContain("could not determine");
  });

  it("stale marker: announces exactly once, then falls silent again", async () => {
    writeFileSync(markerPath(), staleTag);

    const first = await run(["--version"]);
    expect(first.stderr).toContain("openlock: base image changed since last run");
    expect(first.stderr).toContain(staleTag);
    expect(first.stderr).toContain(currentTag);
    // Announcing must not corrupt --version's own stdout contract.
    expect(first.stdout.trim().length).toBeGreaterThan(0);

    // Marker is now rewritten to currentTag — the very next invocation must
    // not announce again.
    expect(readFileSync(markerPath(), "utf-8").trim()).toBe(currentTag);
    const second = await run(["--version"]);
    expect(second.stderr).not.toContain("openlock: base image changed");
  });

  it("no marker but prior openlock state (gateway.pid) exists: soft could-not-determine, not silence", async () => {
    writeFileSync(join(stateDir, "gateway.pid"), "999999");
    const { stderr } = await run(["--version"]);
    expect(stderr).toContain("could not determine");
    expect(readFileSync(markerPath(), "utf-8").trim()).toBe(currentTag);
  });
});
