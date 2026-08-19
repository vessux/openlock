// Integration test for openlock-tv6u: live verification of openlock-k5j2's
// foreign-gateway refusal (PR #134) against TWO REAL, THROWAWAY gateway
// processes — never the developer's real gateway on the default state dir
// / port 18081.
//
// The exhibited k5j2 bug: an isolated-$HOME CLI spawned a gateway that
// failed to bind because another gateway already held the port, then had
// its own readiness `fetch` answered by that FOREIGN gateway anyway — so it
// printed "Gateway ready", wrote PID/DRIVER files for a process that was
// gone/never bound, and would have gone on to create real state through
// someone else's gateway. This test deliberately uses a DIFFERENT
// `OPENLOCK_RUNTIME` for the second gateway than the first — mirroring the
// bug's own reproduction (`OPENLOCK_RUNTIME=docker openlock sandbox`
// colliding with a podman-backed gateway) — but see below on why that
// doesn't guarantee which internal branch actually catches it.
//
// openlock-x8m8 (layer beneath this one) is what makes this test possible
// without inventing a new seam: `OPENLOCK_STATE_DIR` relocates state, and
// the exported, pure `resolveGatewayPort(stateDir)` derives a port from it.
// There is still, deliberately, NO way to request a specific port directly —
// see ensure-gateway.test.ts's header comment on why a port-override seam
// was added and removed during k5j2 itself. So forcing a COLLISION is a
// brute-force search over candidate state-dir paths for one whose derived
// port happens to match the first gateway's — see findCollidingStateDir.
// That search, and every gateway op below, takes the port/state dir as an
// explicit, required argument; nothing here reads an ambient default (see
// src/sandbox/ensure-provider.ts's `Shell` for the pattern this follows).
//
// WHAT THIS TEST CAN AND CANNOT PIN DOWN (revised 2026-08-04 after a run on
// a second machine failed the original "retry until k5j2's specific branch
// fires" design — read this before touching the assertions below):
//
// `waitForGatewayReady`'s per-iteration order is: sleep 1s, THEN check
// whether our own spawned child is still alive, THEN fetch the port.
//   - If the child is already dead at that 1s-mark check, the OLDER,
//     pre-k5j2 "Gateway exited unexpectedly" branch fires (confirmed via
//     `git show <k5j2-commit>~1`: this branch predates k5j2 entirely — it's
//     the original "my own child died, for any reason" handling).
//   - Only if the child is STILL alive at that check, and the readiness
//     fetch then succeeds (because the other gateway is answering), does
//     control reach `classifyPostFetchOutcome` and k5j2's own
//     `refuseForeignGatewayAdoption` ("foreign-dead-child" /
//     "foreign-lsof-mismatch").
// Which branch fires depends entirely on how fast THIS machine's bind
// failure resolves relative to that one-second window — host/container-
// runtime speed, nothing this test (or openlock) controls. Measured live on
// two different machines: one hit k5j2's specific branch 3 of 4 attempts;
// another hit the OLDER generic branch 8 of 8 attempts (~1.8s/attempt) — a
// bind failure that reliably resolves in well under a second there. No
// retry count fixes that: a machine whose bind failure is always fast was
// never exposed to the original k5j2 race in the first place, because the
// pre-existing generic check already caught it before k5j2 ever shipped.
// Treating "reproduce k5j2's exact branch" as the pass condition makes this
// test a coin-flip on a fast machine, or a guaranteed fail — the retry
// loop that used to be here doesn't change that, since the underlying
// probability per attempt doesn't improve with more attempts.
//
// So this test asserts the DURABLE, branch-independent invariant instead —
// a colliding gateway must never adopt, regardless of which branch catches
// it — and logs (console.log) which branch actually fired, purely for a
// human reading CI output. pid/driver/port-file cleanup is asserted ONLY
// when k5j2's specific branch fires; the generic branch is confirmed
// (empirically, and by reading the pre-k5j2 diff) to NOT clean those files
// up — a real, pre-existing gap, unrelated to k5j2 or x8m8, filed
// separately rather than papered over or "fixed" here.
//
// Branch-level precision (exactly which classification fires under which
// synthetic pidAlive/fetch/lsof combination) is already covered
// exhaustively by the PURE unit tests in ensure-gateway.test.ts
// (`classifyReadinessOutcome`, fed `fetchOk`/`childAlive`/`listeningPids`
// directly via fakes) — that is the right place for exact-branch coverage,
// since a fake can force the race a live process cannot. This live test's
// job is narrower and more durable: prove that a colliding gateway never
// silently succeeds, end to end, against the real binary.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 because the test:
//   - requires a working podman AND docker environment,
//   - builds/fetches the real gateway + supervisor image (~minutes cold,
//     seconds once cached),
//   - starts real gateway processes.
//
// SAFETY (read before touching this file):
//   - Every gateway state dir here is a freshly minted `mkdtemp` path under
//     the system tmpdir — these can never canonicalize to the real default
//     state dir (`~/.local/state/openlock`), and the test additionally
//     asserts the derived port is never 18081 as a belt-and-suspenders
//     check. Never call `startGateway()`/the CLI's `gateway start` without
//     an explicit `OPENLOCK_STATE_DIR` override in scope.
//   - `OPENLOCK_STATE_DIR` ALONE IS NOT SUFFICIENT ISOLATION. This bit a
//     real run: `registerGatewayMetadata` (ensure-gateway.ts) writes the
//     SHARED openshell gateway registry at
//     `<XDG_CONFIG_HOME>/openshell/gateways/<GATEWAY_NAME>/metadata.json` —
//     a path keyed by `XDG_CONFIG_HOME` (defaulting to `~/.config`, NOT
//     under the openlock state dir at all) and by the FIXED constant
//     `GATEWAY_NAME` ("podman-dev"). Relocating only `OPENLOCK_STATE_DIR`
//     leaves BOTH throwaway gateways below writing that one real, shared
//     file — the second one to start wins, repointing the developer's
//     (or CI's) real gateway registry at a scratch port that dies with the
//     test, breaking every later command until someone notices and runs
//     `gateway stop && gateway start` to repair it. `XDG_CONFIG_HOME` MUST
//     be overridden to a scratch directory everywhere `OPENLOCK_STATE_DIR`
//     is, for BOTH gateways. `assertRealGatewayRegistryUnchanged` (see the
//     import below, from tests/integration/helpers/scratch-gateway.ts)
//     converts "we hope this is isolated" into a hard, loud failure the
//     moment that stops being true again.
//   - The FIRST gateway (expected to succeed) is started IN-PROCESS via the
//     exported `startGateway()`, matching every other test in this
//     directory — its success path never calls `process.exit()`.
//   - The SECOND gateway (expected to be REFUSED, on either branch) MUST run
//     as a separate CHILD PROCESS. `startGateway()`'s failure paths call
//     `process.exit(1)` — invoking that in-process here would kill the
//     entire test runner, not just this test.
//   - Cleanup is unconditional (`afterEach`, not trailing statements): it
//     scans the scratch root for whatever pid files exist *at teardown
//     time* and kills anything found, so a failing assertion mid-test — or
//     the generic branch's known non-cleanup — still can't leave a real
//     gateway process running.
//   - `requireDisposableHost()` (bd openlock-o4t4/openlock-kjm7) is called
//     as the FIRST statement in the test body, before anything else runs —
//     see that call site's own comment for why that placement, not
//     `it.skipIf`, is what makes this fail-closed rather than
//     skip-then-silent. `it.skipIf(!LIVE)` above still decides whether the
//     test attempts to run at all; `requireDisposableHost()` decides whether
//     it may proceed once it does, and throws (never skips) if not. This is
//     the honest resolution of this file's macOS question (see openlock-kjm7):
//     `XDG_CONFIG_HOME` is the exact lever measured to break `podman machine
//     list` on macOS, and this repo has no way to positively verify safety
//     there without running it — so instead this makes the test CI-only BY
//     CONSTRUCTION rather than by accident. The scratch-gateway isolation
//     mechanism itself (dual OPENLOCK_STATE_DIR + XDG_CONFIG_HOME override,
//     plus the real-registry assertion oracle) now lives in
//     tests/integration/helpers/scratch-gateway.ts — see that file's header
//     for the full platform-applicability writeup before reusing it
//     elsewhere.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGatewayPort, startGateway } from "../../src/sandbox/ensure-gateway";
import { requireDisposableHost } from "./helpers/disposable-host";
import {
  assertRealGatewayRegistryUnchanged,
  captureRealGatewayRegistry,
  scratchGatewayChildEnv,
  withScratchGatewayEnv,
} from "./helpers/scratch-gateway";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");
const DEFAULT_GATEWAY_PORT = 18081;
const COLLISION_SEARCH_CAP = 200_000;

/**
 * Finds a state-dir path (a plain string — not yet created on disk) whose
 * `resolveGatewayPort` output collides with `targetPort`. This is the ONLY
 * way to force two post-x8m8 gateways onto the same port: the port is a
 * deterministic function of the (canonicalized) state-dir path, and there is
 * deliberately no way to request one directly. `avoidPath` is excluded
 * defensively (it can never actually be generated by this search, since
 * candidates use a differently named pattern, but the check costs nothing
 * and guards against a future refactor).
 */
function findCollidingStateDir(scratchRoot: string, targetPort: number, avoidPath: string): string {
  for (let i = 0; i < COLLISION_SEARCH_CAP; i++) {
    const candidate = join(scratchRoot, `state-b-${i}`);
    if (candidate === avoidPath) continue;
    if (resolveGatewayPort(candidate) === targetPort) return candidate;
  }
  throw new Error(
    `could not find a state dir colliding with port ${targetPort} within ${COLLISION_SEARCH_CAP} attempts`,
  );
}

async function spawnAndCapture(
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Reads a state dir's persisted gateway pid, or `null` if absent/unparseable. */
function readPidFile(stateDir: string): number | null {
  try {
    const raw = readFileSync(join(stateDir, "gateway.pid"), "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

describe("k5j2 foreign-gateway refusal, live (openlock-tv6u)", () => {
  let scratchRoot = "";

  afterEach(() => {
    // Guaranteed cleanup regardless of how the test exited: scan whatever
    // scratch-root children exist NOW and kill any live pid found, so a
    // real leak — including one from the generic branch's known
    // non-cleanup, documented in the file header — still gets caught rather
    // than silently orphaned.
    if (scratchRoot && existsSync(scratchRoot)) {
      for (const child of readdirSync(scratchRoot)) {
        const pid = readPidFile(join(scratchRoot, child));
        if (pid !== null) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already dead — fine.
          }
        }
      }
      rmSync(scratchRoot, { recursive: true, force: true });
    }
    scratchRoot = "";
  });

  it.skipIf(!LIVE)(
    "a second gateway colliding on the derived port never adopts the first (exit != 0, no 'Gateway ready', gateway A unaffected, real gateway registry untouched); when k5j2's specific attribution branch fires, it also cleans up its own pid/driver/port files",
    async () => {
      // FIRST statement, before anything else — including the registry
      // capture below. Throws (never skips) if this host hasn't explicitly
      // asserted its state is disposable. See the SAFETY section's own note
      // on why this placement, not `it.skipIf`, is what makes the macOS
      // hazard fail-closed rather than skip-then-silent.
      requireDisposableHost(
        "starting two real gateways with XDG_CONFIG_HOME overridden (openlock-tv6u/k5j2 live verification)",
      );

      // Captured BEFORE any override below — the real, shared registry this
      // test must never touch. See the SAFETY section on why
      // OPENLOCK_STATE_DIR alone doesn't protect it.
      const registrySnapshot = captureRealGatewayRegistry();

      try {
        scratchRoot = mkdtempSync(join(tmpdir(), "openlock-tv6u-"));
        const stateDirA = join(scratchRoot, "state-a");
        const xdgConfigHomeA = join(scratchRoot, "xdg-a");
        const xdgConfigHomeB = join(scratchRoot, "xdg-b");

        const port = resolveGatewayPort(stateDirA);
        // Belt-and-suspenders on top of stateDirA being a freshly minted
        // tmpdir path, which can never canonicalize to the real default
        // state dir: this test must NEVER exercise the developer's real
        // gateway.
        expect(port).not.toBe(DEFAULT_GATEWAY_PORT);

        // Gateway A: IN-PROCESS, expected to SUCCEED (startGateway()'s
        // success path never calls process.exit()). `podman`, matching the
        // "real" instance in k5j2's own reproduction. startGateway()
        // creates stateDirA (and, via registerGatewayMetadata, the scratch
        // XDG_CONFIG_HOME's registry dir) itself. OPENLOCK_RUNTIME is saved/
        // restored here directly — it's driver selection, not part of the
        // scratch-gateway isolation `withScratchGatewayEnv` covers.
        const savedRuntime = process.env.OPENLOCK_RUNTIME;
        process.env.OPENLOCK_RUNTIME = "podman";
        try {
          await withScratchGatewayEnv(stateDirA, xdgConfigHomeA, () => startGateway());
        } finally {
          if (savedRuntime === undefined) delete process.env.OPENLOCK_RUNTIME;
          else process.env.OPENLOCK_RUNTIME = savedRuntime;
        }
        const gatewayAPid = readPidFile(stateDirA);
        expect(gatewayAPid).not.toBeNull();

        const stateDirB = findCollidingStateDir(scratchRoot, port, stateDirA);
        expect(resolveGatewayPort(stateDirB)).toBe(port);

        // Gateway B: a SEPARATE CHILD PROCESS — see the file header on why
        // this can never be an in-process `startGateway()` call. Deliberately
        // `docker` (differs from A's `podman`): whichever branch below
        // catches the collision, it is never via driver comparison — this
        // state dir has no prior recorded driver of its own to compare
        // against. Its own scratch XDG_CONFIG_HOME (separate from A's) keeps
        // its own registerGatewayMetadata write off the real, shared file
        // too.
        const result = await spawnAndCapture(["bun", "run", CLI_PATH, "gateway", "start"], {
          ...scratchGatewayChildEnv(stateDirB, xdgConfigHomeB),
          OPENLOCK_RUNTIME: "docker",
        });
        const combined = `${result.stdout}\n${result.stderr}`;

        // The durable, branch-independent invariant (see file header): a
        // colliding gateway must NEVER silently succeed, on either branch.
        expect(result.code).not.toBe(0);
        expect(combined).not.toContain("Gateway ready");

        // Observability only — NEVER a pass/fail condition. See the file
        // header for why which branch fires depends on this machine's
        // bind-failure speed, not on anything openlock or this test
        // controls.
        const specificBranch = combined.includes("Refusing to adopt it");
        console.log(
          specificBranch
            ? "openlock-tv6u: observed k5j2's specific foreign-adoption branch (refuseForeignGatewayAdoption)"
            : "openlock-tv6u: observed the generic pre-k5j2 'gateway exited unexpectedly' branch — " +
                "still a correct refusal, just not k5j2's attribution path (see file header)",
        );

        if (specificBranch) {
          // formatForeignGatewayAdoptionError's exact wording (ensure-gateway.ts).
          expect(combined).toContain(`127.0.0.1:${port}`);
          expect(combined).toContain("DIFFERENT gateway");
          // refuseForeignGatewayAdoption's cleanup: the pid/driver/port files
          // startGateway() wrote for its own doomed child must not describe a
          // gateway that never actually started. NOT asserted on the generic
          // branch — that branch is known (pre-existing, unrelated to k5j2)
          // to leave these files behind; see the file header.
          expect(existsSync(join(stateDirB, "gateway.pid"))).toBe(false);
          expect(existsSync(join(stateDirB, "gateway.driver"))).toBe(false);
          expect(existsSync(join(stateDirB, "gateway.port"))).toBe(false);
        }

        // Gateway A must be completely unaffected by B's attempt: same pid,
        // still actually the one answering on the port.
        expect(readPidFile(stateDirA)).toBe(gatewayAPid);
        const probe = await fetch(`http://localhost:${port}/`).catch(() => null);
        expect(probe).not.toBeNull();
      } finally {
        // Regression guard for the exact failure this test once caused on a
        // real machine (see the SAFETY section): the real, shared gateway
        // registry must be byte-identical to what it was before this test
        // ran — unchanged if it existed, still absent if it didn't. Placed
        // in `finally` so it runs even when an assertion above already
        // failed, per the same "always verify" discipline as the
        // `afterEach` cleanup.
        assertRealGatewayRegistryUnchanged(registrySnapshot);
      }
    },
    300_000,
  );
});
