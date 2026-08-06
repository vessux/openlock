// Tier B (bd openlock-r19): live regression guard for #26 / v0.5.1 — the
// COMPILED `openlock gateway start` must actually exit once the gateway is
// up, not hang holding the event loop open.
//
// THE BUG THIS GUARDS: `bun run` (interpreter) auto-exits when a script's
// body finishes; a `bun build --compile`d binary does not — it stays alive
// until the event loop drains naturally. #26/v0.5.1 (`ensure-gateway.ts`)
// was exactly this: `startGateway()` spawns the gateway daemon via
// `Bun.spawn` and returns without ever calling `process.exit` — it relies
// entirely on the spawned child being `detached: true` + `.unref()`'d so
// nothing holds the parent's loop open. Under the interpreter this was
// invisible (the interpreter exits regardless); on the compiled binary the
// CLI hung forever after printing "Gateway ready.". Fixed by adding
// `proc.unref()` at the spawn site.
//
// WHY THIS MUST FORCE A FRESH-SPAWN, NOT REUSE A RUNNING GATEWAY:
// `startGateway()` has two branches — "gateway already running" (early
// `return`, no spawn at all) and "spawn a fresh gateway" (the one #26's fix
// actually touches). Every other file in this directory also calls
// `startGateway()`, and bun:test does not guarantee file execution order,
// so if this test ran after one of them the gateway would already be up
// and `gateway start` here would silently take the cheap already-running
// branch — a green result that never exercised the code #26 broke. This
// test forces the fresh-spawn branch deterministically by stopping any
// gateway first and waiting for the OLD pid to actually die (SIGTERM is
// graceful, not instant — starting a new gateway before the old one has
// released its port would be its own race, unrelated to what this test is
// checking) before invoking the compiled binary.
//
// `stopGateway()` here is the same non-destructive operation a developer
// runs by hand (`openlock gateway stop`): it SIGTERMs the daemon and clears
// only its own pid/driver/port tracking files — never `gateway.db` (the
// sandbox/provider registry, see ensure-gateway.ts's `clearGatewayStateFiles`)
// — so a subsequent `gateway start` reloads the same state. This is within
// the same risk envelope this LIVE-gated suite already accepts when run
// locally against a developer's real dev gateway (openlock-18c/openlock-n73d):
// stop+start is the documented repair flow, not a data-destructive sweep.
//
// WHY openlock-to9 (#64) IS DELIBERATELY NOT COVERED HERE, OR ANYWHERE IN
// THIS FILE'S SIBLINGS: to9's bug is in `runSandbox`'s harness-ATTACH exit
// path (session.ts, after `attachHarnessAndSync` returns), which requires a
// real harness binary (claude_code/opencode/pi — actual third-party AI CLI
// tools) to launch inside a real sandbox and exit on its own. None of the
// other 6 files in this directory exercise that path either — they all
// drive the `openshell` CLI directly (see harness-cred-inject.test.ts et
// al.), bypassing `openlock`'s own `session.ts` entirely. Investigation
// (bd openlock-r19):
//   - `execHarness` (src/sandbox/container.ts) hardcodes `tty: "force"` and
//     spawns with stdin/stdout/stderr `"inherit"` — it passes `--tty` to
//     `openshell sandbox exec` unconditionally.
//   - But the fork CLI's own tty decision (run.rs `sandbox_exec_grpc`) only
//     enters actual interactive/raw-mode PTY handling when `--tty` is set
//     AND its own stdin is a real terminal (`std::io::stdin().is_terminal()`).
//     A CI subprocess's stdin is never a real terminal, so in principle the
//     non-interactive streaming path would be taken regardless of the
//     forced flag.
//   - That still requires a real harness binary to actually run inside a
//     real sandbox to prove anything — full image build, gateway, sandbox
//     create, and a credential provider — and the harness is a genuine
//     third-party tool (Claude Code / opencode / pi) whose own behavior
//     when it detects a PTY-shaped exec request (even streamed
//     non-interactively) is outside openlock's control and not verified
//     here: it could print an interactive setup prompt, block on an auth
//     check, or behave differently across its own versions/updates,
//     making a test built on it either flaky or a false sense of coverage.
//   - Reproducing the ORIGINAL reported bug faithfully — a human's actual
//     interactive terminal session — needs a real PTY, which is exactly
//     what bd openlock-r19's own description flags as heavy: "needs a real
//     sandbox + PTY harness exit, like the tuidriver e2e used to verify
//     to9". Building that is a live podman/image-build/gateway/sandbox
//     round trip this session was explicitly told not to attempt (from-
//     source builds can take minutes; see this repo's anti-stall guidance).
// Net: to9's exact path is NOT reproduced by any test in this repo today.
// This is a real, reported gap, not something this file papers over.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayStatus, stopGateway } from "../../src/sandbox/ensure-gateway";
import { pidAlive } from "../../src/sandbox/proc";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
// Generous: a fresh gateway start can pull/build the supervisor image and
// fetch the gateway binary on a cold cache, which is slower than the
// no-infra Tier A cases (tests/compiled-binary-exit.test.ts) by design —
// this tier trades cheapness for actually reproducing #26's live path.
//
// 180s, matching the budget siblings already use for infra-touching work
// (slim-images.test.ts uses 180s/240s). This file sorts FIRST in
// `bun test tests/integration/`, so on a cold CI runner it pays the whole
// suite's warm-up — fetching the pinned fork gateway binary and ensuring the
// supervisor image — inside this one timeout, where later files find both
// cached. A tighter budget here buys nothing: the failure it would produce
// is a slow-cold-cache flake, indistinguishable from the hang this test
// exists to catch, and a guard that cries wolf gets ignored. The cost of the
// looser bound is only paid on a REAL hang (which is the rare case), and the
// job's own `timeout-minutes: 20` remains the outer backstop.
const GATEWAY_START_TIMEOUT_MS = 180_000;

let binPath: string;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "openlock-compiled-gw-"));
  binPath = join(workDir, "openlock");
  // Same invocation .github/workflows/release.yml's "Build single-binary"
  // step uses, minus --target (defaults to the current host, i.e. this CI
  // runner, which is what we want to actually execute here).
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
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Poll until `pid` is no longer alive, or throw. SIGTERM is graceful, not
 * instant — starting a new gateway before the old one released its port
 * would be a self-inflicted race unrelated to what this test checks. */
async function waitUntilPidDead(pid: number | null, timeoutMs = 15_000): Promise<void> {
  if (pid === null) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await Bun.sleep(200);
  }
  throw new Error(
    `gateway pid ${pid} did not die within ${timeoutMs}ms of stopGateway()'s SIGTERM`,
  );
}

/**
 * Run the compiled binary with fully piped stdio (never inherit/TTY — bd
 * openlock-sqw: a long-lived child holding the PARENT's inherited stdout fd
 * only hangs the piped/CI capture path, so a TTY-attached run could pass
 * while the real CI path hangs) and race it against a timeout enforced
 * from our side, since Bun.spawn has no built-in one.
 */
async function runWithTimeout(
  argv: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

describe("compiled `openlock gateway start` exits (Tier B, live — bd openlock-r19, guards #26/v0.5.1)", () => {
  it.skipIf(!LIVE)(
    "starts a fresh gateway and exits, rather than hanging with the event loop held open",
    async () => {
      // Force the fresh-spawn branch: see the file header for why reusing
      // an already-running gateway would make this test a false guard.
      const before = gatewayStatus();
      stopGateway();
      await waitUntilPidDead(before.pid);
      expect(gatewayStatus().running).toBe(false);

      const result = await runWithTimeout([binPath, "gateway", "start"], GATEWAY_START_TIMEOUT_MS);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      // Confirms the spawn actually landed (not just "exited without
      // erroring") — a process that exited 0 without ever starting a
      // gateway would defeat the point of this test just as surely as a
      // hang would.
      expect(gatewayStatus().running).toBe(true);
    },
    GATEWAY_START_TIMEOUT_MS + 30_000,
  );
});
