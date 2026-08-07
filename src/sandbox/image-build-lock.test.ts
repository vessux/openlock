import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bd openlock-jyk: proves `ensureImage`'s lock wiring end-to-end through two
// genuinely separate OS processes, against a fake `podman` (no real
// container runtime, no real build — see feedback_avoid_heavy_podman_calls)
// swapped in via PATH the same way container.test.ts swaps in a fake
// `openshell` via OPENLOCK_OPENSHELL_BIN. `withLock`'s own contention/
// resilience/stale-recovery/release properties are already covered
// generically (and faster) in ../lock.test.ts; this file only needs to show
// that ensureImage actually delegates to it correctly.

const SMOKE_PATH = join(import.meta.dir, "_ensure-image-smoke.ts");

let workDir: string;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function writeFakePodman(binDir: string): void {
  const bin = join(binDir, "podman");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "image" ] && [ "$2" = "exists" ]; then',
      '  test -f "$OPENLOCK_TEST_MARKER"',
      "  exit $?",
      "fi",
      'if [ "$1" = "build" ]; then',
      '  echo build >> "$OPENLOCK_TEST_LOG"',
      "  remaining=0",
      '  if [ -f "$OPENLOCK_TEST_FAILURES" ]; then remaining=$(cat "$OPENLOCK_TEST_FAILURES"); fi',
      '  if [ "$remaining" -gt 0 ]; then',
      "    remaining=$((remaining - 1))",
      '    echo "$remaining" > "$OPENLOCK_TEST_FAILURES"',
      "    exit 1",
      "  fi",
      '  touch "$OPENLOCK_TEST_MARKER"',
      "  exit 0",
      "fi",
      'echo "fake podman: unrecognized args: $@" 1>&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
}

/** Isolated HOME (ensureImage's context dir + lock file are HOME-relative)
 * and a PATH-shadowed fake podman — never touches the real
 * ~/.cache/openlock or a real container runtime. */
function baseEnv(dir: string): Record<string, string> {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFakePodman(bin);
  return {
    ...process.env,
    OPENLOCK_LOCK_SMOKE: "1",
    OPENLOCK_RUNTIME: "podman",
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    OPENLOCK_TEST_LOG: join(dir, "log"),
    OPENLOCK_TEST_MARKER: join(dir, "marker"),
    OPENLOCK_TEST_FAILURES: join(dir, "failures"),
  };
}

interface SmokeResult {
  ok: boolean;
  result?: { tag: string; built: boolean };
  error?: string;
}

async function runEnsure(
  env: Record<string, string>,
  containerfileContent: string,
  tagPrefix: string,
): Promise<SmokeResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SMOKE_PATH, containerfileContent, tagPrefix],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`ensureImage smoke exited ${code}: ${stderr}`);
  return JSON.parse(stdout.trim());
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
}

describe("ensureImage lock wiring (openlock-jyk)", () => {
  it("two concurrent invocations building identical content: exactly one real podman build", async () => {
    workDir = mkdtempSync(join(tmpdir(), "openlock-ensure-image-lock-"));
    writeFileSync(join(workDir, "log"), "");
    const env = baseEnv(workDir);
    const content = "FROM scratch\nRUN echo hi\n";

    const [a, b] = await Promise.all([
      runEnsure(env, content, "openlock-lock-it"),
      runEnsure(env, content, "openlock-lock-it"),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result?.tag).toBe(b.result?.tag);
    const builtCount = [a.result?.built, b.result?.built].filter((v) => v === true).length;
    expect(builtCount).toBe(1);
    expect(readLines(join(workDir, "log"))).toHaveLength(1);
  });

  it("a failed build is not cached: the waiter's own attempt still succeeds", async () => {
    workDir = mkdtempSync(join(tmpdir(), "openlock-ensure-image-lock-"));
    writeFileSync(join(workDir, "log"), "");
    const env = baseEnv(workDir);
    writeFileSync(join(workDir, "failures"), "1");
    const content = "FROM scratch\nRUN echo bye\n";

    const [a, b] = await Promise.all([
      runEnsure(env, content, "openlock-lock-it-fail"),
      runEnsure(env, content, "openlock-lock-it-fail"),
    ]);

    const results = [a, b];
    const failed = results.filter((r) => !r.ok);
    const succeeded = results.filter((r) => r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatch(/build failed/);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.result?.built).toBe(true);
    // Both attempted the build (leader's failure didn't stop the waiter from
    // trying its own): 2 podman build invocations for 1 eventual success.
    expect(readLines(join(workDir, "log"))).toHaveLength(2);
  });
});
