// Tier A (bd openlock-r19): hermetic compiled-binary exit smoke test.
//
// WHY THIS EXISTS: `bun run` (the interpreter) auto-exits when a script's
// body finishes; a `bun build --compile`d binary does NOT — it stays alive
// until the event loop drains on its own. A dangling handle (an un-`unref`'d
// `Bun.spawn`, a repeating timer, a spawned child inheriting a stdio fd it
// shouldn't) is therefore invisible to every OTHER test in this repo, since
// they all run through the interpreter. This class of bug has bitten twice:
//   - #26 / v0.5.1 (`ensure-gateway.ts`): a Bun.spawn subprocess handle held
//     the event loop open after "Gateway ready." printed. Fixed with
//     `proc.unref()`.
//   - openlock-to9 / #64 (`session.ts`): the persistent-container tether +
//     gateway client are intentionally left running after a harness exits,
//     so `runSandbox` hung unless it called `process.exit` unconditionally.
//
// WHAT THIS TIER DOES NOT COVER — read before treating a green run here as
// a regression guard for either bug above. Both live on paths that need a
// real gateway (#26) or a real gateway + sandbox + attached harness (to9);
// neither is reachable with zero infrastructure. This tier only exercises
// commands that need NO gateway, NO container runtime, and NO sandbox — the
// CLI's flag-parsing/startup path, executed before any subcommand's own
// logic runs. A green result here is honest insurance against a NEW
// dangling handle introduced in that shared startup path (a module-level
// spawn or timer, for example); it is NOT evidence that #26 or to9 still
// can't regress. The live counterpart —
// tests/integration/compiled-binary-gateway-start.test.ts (Tier B, same bd
// issue) — is the one that reproduces #26's exact path on the compiled
// binary; see that file's header for why to9's own path could not be
// reproduced the same way.
//
// MECHANICS:
//   - Compiles src/cli.ts with exactly the flags
//     .github/workflows/release.yml's "Build single-binary" step uses
//     (minus --target, which release.yml varies per matrix leg and which we
//     want to default to the current host here) — a --compile/--define
//     mismatch could itself change behavior, so this doesn't invent its own
//     flag set.
//   - Runs the compiled binary with stdout/stderr fully PIPED, never
//     inherited and never a TTY. bd openlock-sqw: a long-lived child
//     holding the PARENT's inherited stdout fd only hangs the piped/CI
//     capture path — a TTY-attached run can pass while the real CI path
//     (which always pipes) hangs. Piping here is what makes this test able
//     to catch that class at all.
//   - Enforces its own timeout. Bun.spawn has no built-in one, so a genuine
//     hang would otherwise wedge this test (and the CI job) forever instead
//     of failing loudly — which is exactly the failure mode this test
//     exists to turn into a fast, clear red.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXIT_TIMEOUT_MS = 10_000;

let binPath: string;
let workDir: string;
// openlock-q7b8: cli.ts's main() now calls announceBaseImageChangeIfNeeded()
// unconditionally, before ANY of these flags' own short-circuits (see
// src/cli.ts and src/sandbox/base-image-announce.ts, bd openlock-u7ca) — it
// reads/writes a marker file under the resolved state dir on every
// invocation, including --version/--help/no-args, not just
// --print-base-tag. Without OPENLOCK_STATE_DIR this spawn fell through to
// the developer's REAL default state dir (confirmed: it had already written
// ~/.local/state/openlock/base-tag.seen on this machine before this fix),
// which is exactly the synthetic-state-only rule this project was burned
// into adopting (feedback_tests_synthetic_state_only.md) — this file's own
// sibling retrofits (src/cli/print-base-tag.test.ts et al., same bd
// openlock-u7ca) already isolate this same call for every OTHER spawn path;
// this compiled-binary path was the one missed.
let stateDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "openlock-compiled-exit-"));
  binPath = join(workDir, "openlock");
  stateDir = mkdtempSync(join(tmpdir(), "openlock-compiled-exit-state-"));
  const build = Bun.spawn(
    [
      "bun",
      "build",
      "src/cli.ts",
      "--compile",
      "--define",
      'OPENLOCK_BUILD_SHA="smoketest"',
      `--outfile=${binPath}`,
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) {
    throw new Error(`bun build --compile failed (exit ${code}): ${stderr}`);
  }
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * Run the compiled binary with fully piped stdio (never inherit/TTY — see
 * openlock-sqw above) and race it against a timeout enforced from OUR side.
 * A hang here must become a failed assertion, never an indefinitely blocked
 * test process.
 */
async function runWithTimeout(
  args: string[],
): Promise<{ exitCode: number; stdout: string; timedOut: boolean }> {
  const proc = Bun.spawn([binPath, ...args], {
    env: { ...process.env, OPENLOCK_STATE_DIR: stateDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, EXIT_TIMEOUT_MS);
  try {
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { exitCode, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

describe("compiled binary exits on no-infra commands (Tier A, hermetic — bd openlock-r19)", () => {
  // Every case here is deliberately something the CLI can answer without
  // ever touching a gateway, container runtime, or sandbox — see the file
  // header for why that means this tier proves less than it might look
  // like it proves.
  const noInfraCases: { name: string; args: string[] }[] = [
    { name: "--version", args: ["--version"] },
    { name: "-v", args: ["-v"] },
    { name: "--help", args: ["--help"] },
    { name: "-h", args: ["-h"] },
    { name: "--print-base-tag", args: ["--print-base-tag"] },
    { name: "no args (usage)", args: [] },
  ];

  for (const { name, args } of noInfraCases) {
    it(`${name} exits within ${EXIT_TIMEOUT_MS}ms, not hangs`, async () => {
      const result = await runWithTimeout(args);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });
  }
});
