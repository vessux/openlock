// Tier C (bd openlock-3zjx): live regression guard for openlock-to9 (#64) —
// `runSandbox`'s harness-ATTACH exit path (src/sandbox/session.ts, after
// `attachHarnessAndSync` returns). The bug: `process.exit` was only called
// on a NON-ZERO harness exit code, so a harness that exited 0 fell through —
// the persistent-container tether (`openshell sandbox create … sleep
// infinity`) and the gateway client are intentionally left running after
// attach, so the compiled binary's event loop never drained and the CLI hung
// forever. The fix (session.ts, `process.exit(exitCode)` called
// UNCONDITIONALLY after the harness exits) is what this test guards.
//
// WHY A STUB HARNESS, NOT A REAL ONE (Claude Code / opencode / pi):
// bd openlock-r19 investigated this exact path and stopped rather than ship
// a test built on a real third-party harness binary — see
// compiled-binary-gateway-start.test.ts's header for the full writeup. A
// real harness's behavior when handed a PTY-shaped exec request (even one
// that, per the confirmed mechanism below, is actually streamed
// non-interactively) is outside openlock's control and not verified here: it
// could print an interactive setup prompt, block on an auth check, or behave
// differently across its own versions. That risk is exactly the trap that
// would make a test here EITHER flaky OR a false sense of coverage — so this
// test installs a throwaway `/usr/local/bin/pi` shell script (`exit 0`
// immediately) into the sandbox image instead of using the real `pi` CLI.
// `opts.harness` still resolves to the real `"pi"` Harness value — only the
// BINARY the image ships at that path is fake; no change to harness.ts's
// closed Harness union was needed or made.
//
// THE is_terminal() MECHANISM THAT MAKES THIS REACHABLE WITHOUT A REAL PTY
// (confirmed by reading the pinned fork source, openshell-fork/crates/
// openshell-cli/src/run.rs, fn sandbox_exec_grpc):
//   `execHarness` (src/sandbox/container.ts) hardcodes `tty: "force"`, so
//   `openshell sandbox exec` always gets `--tty`, setting `tty_override =
//   Some(true)`. But:
//     if tty_override == Some(true) && std::io::stdin().is_terminal() {
//         return sandbox_exec_interactive_grpc(...).await;
//     }
//   — the raw-mode/interactive PTY branch is entered ONLY when the CLI's
//   OWN stdin is ALSO a real terminal. A piped/CI subprocess's stdin never
//   is, so control falls through to the plain streaming `exec_sandbox` gRPC
//   call instead — the ordinary non-interactive path, reachable with zero
//   PTY involvement. This test spawns the compiled binary with
//   `stdin: "ignore"` specifically so that mechanism applies.
//
// WHAT THIS TEST DOES NOT PROVE (read before treating a green run here as
// broader coverage than it is):
//   - NO real-harness fidelity. A real Claude Code / opencode / pi binary
//     could still print an interactive setup prompt, block on an auth
//     check, or otherwise behave unlike this stub when actually handed a
//     PTY-shaped exec request — this test sidesteps that question entirely
//     by construction, it does not answer it.
//   - NO real-credential validation. The OpenRouter credential fabricated
//     below (see `FAKE_OPENROUTER_RECORD`) is syntactically valid but never
//     checked against the real upstream API — the stub harness makes no
//     network call, so an invalid/expired/fake key is never exercised. This
//     is what makes the test CI-portable with zero secrets, but it also
//     means this test proves nothing about real provider auth.
//   - Does NOT reproduce the original human-interactive-terminal scenario
//     that filed #64 (openlock-to9) — that needs a real PTY attached to a
//     real terminal, which this deliberately avoids for the reasons above.
//   - Proves ONLY: given a harness process that exits fast (with code 0),
//     the compiled `openlock` binary itself also exits promptly rather than
//     hanging on the dangling tether/gateway-client handles. Nothing more.
//
// WHY NO ENV-VAR ISOLATION (XDG_CONFIG_HOME / OPENLOCK_STATE_DIR): an
// earlier draft of this test tried to sandbox `runSandbox`'s host-side
// state by overriding both. Empirically, on macOS, overriding
// XDG_CONFIG_HOME breaks `podman machine list`'s own connection lookup
// (verified directly: `XDG_CONFIG_HOME=<fake> podman machine list` returns
// an EMPTY table even with a real machine running) — podman itself honors
// XDG_CONFIG_HOME for its own config, same as ensure-gateway.ts's
// `registerGatewayMetadata`/src/tokens.ts's `credentialsPath` do. And
// relocating ONLY `OPENLOCK_STATE_DIR` without also relocating the gateway
// registry is the EXACT clobbering mistake this project already hit once
// (a prior test run clobbered the real gateway registry this same way): a
// fresh state dir forces `startGateway`'s fresh-spawn branch, which
// re-registers the FIXED-name `podman-dev` gateway — overwriting the real
// one's metadata out from under it. So this test does the opposite:
// it runs against the REAL, ALREADY-RUNNING shared dev gateway (same as
// every sibling file in this directory), and instead backs up + restores
// the two small pieces of real state it needs to touch:
//   - `~/.config/openlock/credentials.json`: backed up to an on-disk
//     `.attach-test-bak` file (verified readback, mirroring src/tokens.ts's
//     own `backupLegacyFile` discipline) before a fabricated `openrouter`
//     entry is merged in; restored byte-for-byte in `afterAll`. Verified
//     live against BOTH branches: the file existing (normal dev box) and
//     the file NOT existing at all (a fresh CI runner's first run) — the
//     latter was moved-aside-and-restored by hand once to confirm teardown
//     removes the file again rather than resurrecting an empty one.
//
// A REAL PRE-EXISTING `openrouter` GATEWAY PROVIDER MAKES THIS TEST REFUSE
// TO RUN, RATHER THAN TRY TO PROTECT IT (bd openlock-3zjx follow-up): unlike
// `credentials.json`, the gateway-side provider CANNOT be backed up —
// `openshell provider list` prints only NAME/TYPE/CREDENTIAL_KEYS/
// CONFIG_KEYS, never the credential VALUES, so there is no way to read back
// what to restore. And `ensureProvider`'s non-refresh path (openrouter is a
// static bearer token, not OAuth) does `provider update` on an EXISTING
// provider (src/sandbox/ensure-provider.ts) — so if a real `openrouter`
// provider is already registered, running this test would silently
// overwrite the user's real credential with the fabricated one, with NO way
// back. This is the exact failure class this project has already been
// burned by once (a test that deleted/overwrote real gateway providers,
// including an unrecoverable anthropic credential). So `beforeAll` checks
// `provider list` FIRST, before touching anything else, and if `openrouter`
// already exists: skips the credential fabrication, the binary build, and
// the image build entirely, and the `it` body prints a loud, greppable
// refusal banner (`OPENLOCK-3ZJX: TEST REFUSED TO RUN`) and returns without
// creating anything. The teardown guard that only deletes a provider this
// run itself created is KEPT as a second, independent layer (belt and
// braces) — but the real fix is refusing to run at all, not hoping teardown
// gets the ordering right afterward.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 like every other file in this
// directory: requires a working podman/docker environment, builds a real
// (one-extra-layer) sandbox image, uses the real dev gateway, and
// creates/attaches/tears down a real container.
//
// VERIFICATION SCOPE: the no-env-isolation design above should be
// runtime-agnostic — it never touches podman- or docker-specific config
// paths, only openlock's own gateway/credentials state — but it has been
// exercised live ONLY on macOS + podman (this dev box). The
// `live-integration` CI job's `docker` matrix leg and any Linux runner are
// UNVERIFIED for this specific file; nothing here is known to be
// docker/Linux-incompatible, but nothing has confirmed it either.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSandboxGetArgv, parseSandboxGetPhase } from "../../src/sandbox/container";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { providerExistsInGateway } from "../../src/sandbox/ensure-provider";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";
import { findSessionsByPath, sessionsDir } from "../../src/sandbox/session-store";
import { credentialsPath } from "../../src/tokens";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const FIXTURE_POLICY = resolve(__dirname, "../fixtures/policies/test-pi-stub-attach.yaml");
const OPENROUTER = "openrouter";

// The gateway is pre-warmed in `beforeAll` (outside this budget) precisely
// so this timeout only has to cover what this test actually measures: the
// one-extra-layer sandbox image build (fast; cache-hit after the first run
// in this suite) + create + attach + harness exit + binary exit. Still
// generous — a tighter bound buys nothing, since the failure it would
// produce on a slow-but-healthy run is indistinguishable from the real hang
// this test exists to catch, and a guard that cries wolf gets ignored.
const ATTACH_TIMEOUT_MS = 180_000;

// Deliberately NOT a real key — the stub harness never makes a network
// call, so this is never checked against the real OpenRouter API. Shaped to
// pass the provider plugin's OWN format validation
// (src/providers/openrouter.ts's `validateOpenRouterKey`) purely so nothing
// downstream trips on an obviously-malformed value; never treated as a
// secret worth protecting.
const FAKE_OPENROUTER_RECORD = {
  type: "generic",
  credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-fake-test-key-not-real-0000000000" },
  created_at: new Date(0).toISOString(),
};

// Deliberately loud and greppable (see the header's "REAL PRE-EXISTING
// openrouter GATEWAY PROVIDER" section for why this exists at all) — a
// silently-skipped test is its own false-green, so this must be impossible
// to miss in CI output or a local run.
const REFUSAL_BANNER = [
  "",
  "==================== OPENLOCK-3ZJX: TEST REFUSED TO RUN ====================",
  "A real 'openrouter' gateway provider is ALREADY REGISTERED on this gateway.",
  "Running this test would overwrite it with a FABRICATED test-only credential",
  "(via openshell's `provider update` — see src/sandbox/ensure-provider.ts's",
  "non-refresh path). Gateway provider VALUES cannot be read back (`provider",
  "list` never prints them), so that overwrite would be UNRECOVERABLE: your",
  "real OpenRouter credential would be gone with no way to restore it.",
  "",
  "openlock-3zjx's coverage of runSandbox's harness-ATTACH exit path did NOT",
  "run this pass. This is a refusal, not a pass on the merits.",
  "",
  "To actually run this test: remove the 'openrouter' provider from this",
  "gateway first if you don't need it (`openshell provider delete openrouter`),",
  "or point this run at a scratch gateway (e.g. a fresh OPENLOCK_STATE_DIR)",
  "that has no real 'openrouter' provider — then re-run.",
  "===============================================================================",
  "",
].join("\n");

let binPath: string;
let workDir: string | undefined;
let repoDir: string;
let credentialsBackupPath: string | null = null;
let originalCredentialsExisted = false;
let openrouterProviderPreexisted = false;
/** True ONLY once `backupAndFabricateCredentials` has actually mutated the
 * real `credentials.json` — set at the point of mutation, not inferred from
 * any broader "did beforeAll finish" state. This is the ONLY thing
 * `restoreCredentials` may trust: an earlier bug had `restoreCredentials`
 * fall through to its "the file didn't exist before" branch — deleting the
 * REAL file — on `beforeAll`'s early-return refusal path, precisely because
 * `originalCredentialsExisted`'s default (`false`) looked indistinguishable
 * from "confirmed, the file really didn't exist". This flag can never be
 * `true` unless the real file was actually read/backed-up/mutated first, so
 * a path that never got that far can never trigger the delete branch. */
let credentialsFabricated = false;
/** Set once the sandbox's real (session-generated) name is known, read back
 * from the REAL session store after the run — tracked at module scope
 * (openlock-18c: an in-body-only reference is lost on a bun test TIMEOUT,
 * since the body's own scope unwinds without running an in-body `finally`;
 * `afterAll` still runs and needs this). */
let registeredSandboxName: string | null = null;

async function spawnAndCapture(
  argv: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Back up the REAL `~/.config/openlock/credentials.json` (verified
 * readback before touching the original — never truncate on the strength of
 * an unverified backup, mirroring src/tokens.ts's own `backupLegacyFile`),
 * then merge in a fabricated `openrouter` entry alongside whatever else was
 * already there. Never overwrites an existing `openrouter` entry's shape
 * without a way back — `restoreCredentials` reverts byte-for-byte. */
function backupAndFabricateCredentials(): void {
  const path = credentialsPath();
  originalCredentialsExisted = existsSync(path);
  let doc: { version: 2; providers: Record<string, unknown> } = { version: 2, providers: {} };
  if (originalCredentialsExisted) {
    const raw = readFileSync(path, "utf-8");
    const backup = `${path}.attach-test-bak-${process.pid}`;
    writeFileSync(backup, raw);
    if (readFileSync(backup, "utf-8") !== raw) {
      throw new Error(`could not verify credentials backup at ${backup}; aborting`);
    }
    credentialsBackupPath = backup;
    try {
      doc = JSON.parse(raw);
    } catch {
      doc = { version: 2, providers: {} };
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  doc.providers[OPENROUTER] = FAKE_OPENROUTER_RECORD;
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  // Only set once the real file has actually been read/backed-up (or
  // confirmed absent) AND the fabricated write has landed — see this flag's
  // own doc comment for why `restoreCredentials` must gate on THIS, not on
  // `originalCredentialsExisted`'s default.
  credentialsFabricated = true;
}

/** Restore `credentials.json` to exactly what it was before this test ran
 * — from the on-disk backup if one exists, or by removing the file if it
 * didn't exist beforehand. Never leaves the fabricated entry behind. A no-op
 * if `backupAndFabricateCredentials` never actually ran (e.g. `beforeAll`'s
 * refusal path) — see `credentialsFabricated`'s doc comment; this guard is
 * the fix for a real incident where its absence deleted a live
 * `credentials.json` that this test had never touched. */
function restoreCredentials(): void {
  if (!credentialsFabricated) return;
  const path = credentialsPath();
  if (credentialsBackupPath !== null) {
    writeFileSync(path, readFileSync(credentialsBackupPath, "utf-8"));
    rmSync(credentialsBackupPath, { force: true });
    credentialsBackupPath = null;
  } else if (!originalCredentialsExisted) {
    rmSync(path, { force: true });
  }
}

function writeStubHarnessContainerfile(dir: string, baseImageTag: string): void {
  const openlockDir = join(dir, ".openlock");
  mkdirSync(openlockDir, { recursive: true });
  const content = [
    `FROM ${baseImageTag}`,
    "USER root",
    "RUN printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/pi && chmod +x /usr/local/bin/pi",
    "USER sandbox",
    "",
  ].join("\n");
  writeFileSync(join(openlockDir, "Containerfile"), content);
}

/** openlock-18c: `sandbox delete`/`clean` returns once the gateway ACCEPTS
 * the delete, not once it COMPLETES — the provider stays "attached to
 * sandbox(es)" until the async teardown actually lands, so
 * sandbox-before-provider ORDERING alone is not sufficient. Poll `openshell
 * sandbox get` (via the pure `buildSandboxGetArgv`/`parseSandboxGetPhase`
 * helpers container.ts already exports) until it reports missing. See
 * post-create-exec-proxy.test.ts's `waitForSandboxGone` for the original
 * discovery writeup. */
async function waitForSandboxGone(
  cli: { argv: string[]; cwd: string | undefined },
  name: string,
  timeoutMs = 60_000,
): Promise<void> {
  const argv = buildSandboxGetArgv(cli.argv, name);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await spawnAndCapture(argv, cli.cwd);
    if (r.code !== 0) {
      if (/sandbox not found|NotFound/.test(r.stderr)) return;
    } else if (parseSandboxGetPhase(r.stdout) === "missing") {
      return;
    }
    await Bun.sleep(750);
  }
  throw new Error(
    `openlock-18c: sandbox ${name} still not reported gone ${timeoutMs}ms after its delete was accepted`,
  );
}

/** Strict, loud teardown against the REAL dev gateway: `openlock clean
 * <name>` (production code — handles the gateway-side delete AND the local
 * session-store meta.json removal in one step, exactly what a developer
 * would run by hand), then wait for the async delete to actually land
 * before removing the fabricated provider — but ONLY if this test's own
 * `beforeAll` didn't find a real `openrouter` provider already registered.
 * Never a raw `podman rm` (this project leans on the openshell/openlock
 * abstractions, not the underlying runtime, for sandbox-side ops). */
async function teardownGatewayState(): Promise<void> {
  const cli = await getCliInvocation();
  const errors: string[] = [];
  if (registeredSandboxName !== null) {
    const clean = await spawnAndCapture([binPath, "clean", registeredSandboxName]);
    if (clean.code !== 0) {
      errors.push(
        `openlock clean ${registeredSandboxName} failed (exit ${clean.code}): ${clean.stderr}`,
      );
    } else {
      try {
        await waitForSandboxGone(cli, registeredSandboxName);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (!openrouterProviderPreexisted) {
    const providerDel = await spawnAndCapture(
      [...cli.argv, "provider", "delete", OPENROUTER],
      cli.cwd,
    );
    if (providerDel.code !== 0) {
      errors.push(
        `provider delete ${OPENROUTER} failed (exit ${providerDel.code}): ${providerDel.stderr}`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`openlock-18c: gateway teardown left leaked state:\n${errors.join("\n")}`);
  }
}

/**
 * Run the compiled binary with fully piped stdio (never inherit/TTY — bd
 * openlock-sqw: a long-lived child holding the PARENT's inherited stdout fd
 * only hangs the piped/CI capture path, so a TTY-attached run could pass
 * while the real CI path hangs) and race it against a timeout enforced from
 * OUR side, since Bun.spawn has no built-in one.
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

beforeAll(async () => {
  // bun:test runs beforeAll/afterAll even when the file's ONLY test is
  // `it.skipIf`-skipped (verified empirically, not assumed) — so without
  // this guard, every plain `bun run test` would unconditionally build a
  // compiled binary AND mutate the REAL `~/.config/openlock/credentials.json`
  // (backup + fabricate) and touch the real gateway, exactly the cost this
  // suite's LIVE gate exists to avoid on the default path (see this
  // project's own note on ci.yml: "Kept off the default `bun test` path so
  // local dev stays fast"). Every sibling file in this directory avoids this
  // by keeping gateway/credential-touching work inside the `it.skipIf`
  // body; this file instead pre-warms the gateway in `beforeAll` (see
  // ATTACH_TIMEOUT_MS's comment for why), so the guard has to live here.
  if (!LIVE) return;

  // Check FIRST, before touching credentials.json, building anything, or
  // creating a Containerfile — none of that must happen at all if a real
  // `openrouter` provider is already registered (see the header's "REAL
  // PRE-EXISTING openrouter GATEWAY PROVIDER" section). Also pre-warms the
  // real dev gateway here, outside ATTACH_TIMEOUT_MS's budget.
  await startGateway();
  const cli = await getCliInvocation();
  const list = await spawnAndCapture([...cli.argv, "provider", "list"], cli.cwd);
  if (list.code !== 0) {
    throw new Error(`openshell provider list failed (exit ${list.code}): ${list.stderr}`);
  }
  openrouterProviderPreexisted = providerExistsInGateway(list.stdout, OPENROUTER);
  if (openrouterProviderPreexisted) return; // the `it` body prints the refusal banner and exits early.

  workDir = mkdtempSync(join(tmpdir(), "openlock-attach-exit-"));
  binPath = join(workDir, "openlock");
  repoDir = join(workDir, "repo");
  mkdirSync(repoDir, { recursive: true });

  backupAndFabricateCredentials();

  // Same invocation .github/workflows/release.yml's "Build single-binary"
  // step uses, minus --target (defaults to the current host, which is what
  // we want to actually execute here).
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

  // Reuses the SAME base-image cache every sibling integration test builds
  // from (tagPrefix "openlock-base-it") — if another file in this directory
  // already ran in this process/CI job, this is a cache hit, not a rebuild.
  const base = await ensureImage({
    containerfileContent: BASE_CONTAINERFILE,
    tagPrefix: "openlock-base-it",
  });
  writeStubHarnessContainerfile(repoDir, base.tag);
}, 180_000);

afterAll(async () => {
  // Mirrors the `beforeAll` guard above — nothing was set up when !LIVE, so
  // there is nothing to tear down. Without this, `teardownGatewayState`
  // would still run its unconditional `provider delete openrouter` against
  // the REAL gateway on every plain `bun run test` (openrouterProviderPreexisted
  // defaults to `false`), which is exactly the kind of always-on live
  // mutation this guard exists to prevent.
  if (!LIVE) return;
  // openlock-18c: explicit timeout required — hooks default to 5000ms
  // regardless of the `it`'s own budget, and gateway/sandbox teardown
  // exceeds that.
  try {
    await teardownGatewayState();
  } finally {
    restoreCredentials();
    // `workDir` is unset on `beforeAll`'s refusal path (see the header's
    // "REAL PRE-EXISTING openrouter GATEWAY PROVIDER" section) — guard
    // rather than assume it was created, mirroring `credentialsFabricated`'s
    // guard on `restoreCredentials` just above.
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  }
}, 120_000);

describe("compiled `openlock sandbox` exits after harness attach (Tier C, live — bd openlock-3zjx, guards openlock-to9/#64)", () => {
  it.skipIf(!LIVE)(
    "a stub harness exiting 0 lets the compiled binary exit too, rather than hanging on the tether/gateway-client handles",
    async () => {
      // See the file header's "REAL PRE-EXISTING openrouter GATEWAY
      // PROVIDER" section: `beforeAll` already refused to fabricate a
      // credential, build a binary, or build an image on this path — this
      // must return before touching `binPath`/`repoDir` (unset here) or
      // creating anything at all.
      if (openrouterProviderPreexisted) {
        console.error(REFUSAL_BANNER);
        return;
      }

      const result = await runWithTimeout(
        [
          binPath,
          "sandbox",
          repoDir,
          "--harness",
          "pi",
          "--provider",
          OPENROUTER,
          "--policy",
          FIXTURE_POLICY,
        ],
        ATTACH_TIMEOUT_MS,
      );

      // Record the session name for afterAll's teardown regardless of
      // outcome (openlock-18c: a timeout skips everything after this point
      // in the body, so this must happen before any assertion that could
      // throw).
      registeredSandboxName = findSessionsByPath(sessionsDir(), repoDir)[0]?.name ?? null;

      if (result.timedOut) {
        throw new Error(
          `binary did not exit within ${ATTACH_TIMEOUT_MS}ms — stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `binary exited ${result.exitCode}, expected 0 — stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    },
    ATTACH_TIMEOUT_MS + 30_000,
  );
});
