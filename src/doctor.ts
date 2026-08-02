import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { commandExists } from "./command-exists";
import { readGlobalConfig } from "./global-config";
import { globalConfigPath } from "./global-config/paths";
import { forkDir } from "./paths";
import { type BinaryProbes, RUNTIMES, type Runtime, resolveRuntimeNonInteractive } from "./runtime";
import { GATEWAY_PORT, gatewayStatus } from "./sandbox/ensure-gateway";
import { isDevMode } from "./sandbox/fork-binaries";
import { SANDBOX_UID } from "./sandbox/seed-containerfile";
import { rangeCoversUid } from "./sandbox/subuid";
import { hasAnyProvider } from "./tokens";

const SUBUID_FIX =
  "sudo usermod --add-subuids 100000-1100000 --add-subgids 100000-1100000 $USER && podman system migrate";

/** Read /etc/subuid for injection in tests; defaults to the real file. */
function defaultReadSubuid(): string {
  try {
    return readFileSync("/etc/subuid", "utf8");
  } catch {
    return "";
  }
}

const DOCKER_INSTALL_DOCS = "https://docs.docker.com/engine/install/";

/** Platform-aware install hint. macOS points at brew (a safe, near-universal
 * assumption for Mac devs). Linux distros vary too much to guess a single
 * package manager reliably (apt vs dnf vs pacman vs zypper vs apk, plus
 * ID_LIKE chains) — a hint that guesses wrong is worse than one that doesn't
 * guess, so Linux stays package-manager-neutral rather than hardcoding one. */
export function installHint(pkg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return `brew install ${pkg}`;
  return `install ${pkg} via your distro's package manager (e.g. apt, dnf, pacman)`;
}

interface CheckOutcome {
  ok: boolean;
  detail?: string;
  fix?: string;
}

interface Check {
  name: string;
  test: () => Promise<boolean | CheckOutcome>;
  fix?: string;
}

export async function podmanMachineRunning(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["podman", "machine", "info"], { stdout: "pipe", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) return false;
    const output = await new Response(proc.stdout).text();
    return /machinestate:\s*Running/i.test(output);
  } catch {
    return false;
  }
}

export async function dockerDaemonReachable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function podmanSocketActive(): Promise<boolean> {
  // `podman info` succeeds even when the API socket is inactive (the CLI
  // talks to libpod directly), and a stale socket *file* can linger after
  // `systemctl stop`. The only reliable check is to actually open a
  // connection and ping the API — which is what the gateway does.
  // Bound the curl call with --max-time so a stale socket can't hang us.
  try {
    const proc = Bun.spawn(["podman", "info", "--format", "{{.Host.RemoteSocket.Path}}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return false;
    const socketPath = out.trim().replace(/^unix:\/\//, "");
    const ping = Bun.spawn(
      ["curl", "-fsS", "--max-time", "2", "--unix-socket", socketPath, "http://d/_ping"],
      { stdout: "ignore", stderr: "ignore" },
    );
    return (await ping.exited) === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// GH #75 / bd openlock-7er piece 1: bridge-network sandbox containers reach
// the gateway via `host.containers.internal` -> netavark DNAT. A host
// firewalld/nftables reload (or podman network event) can flush those NAT
// rules; containers then can't fetch policy from the gateway and exit 1. This
// check reproduces that exact path (a real container on the sandbox network
// probing the gateway port) rather than the loopback-only checks above, which
// can't see it. Podman/netavark-specific — no-ops on docker (see below).
// ============================================================================

// Matches the fork's podman driver DEFAULT_NETWORK_NAME
// (crates/openshell-driver-podman/src/config.rs) — sandbox containers attach
// to this network. Not exported from the fork's TS surface, so mirrored here
// like SANDBOX_UID above.
const OPENSHELL_NETWORK_NAME = "openshell";
// Tiny, universally-available image with a `nc` (busybox applet); `--pull
// missing` below means no network hit at all once it's cached once.
const REACHABILITY_PROBE_IMAGE = "docker.io/library/busybox:latest";
const REACHABILITY_PROBE_TIMEOUT_MS = 15_000;
// Podman's own operational failures (image pull failed, network unknown,
// couldn't start the container at all) surface as 125/126/127 or our own
// timeout-kill sentinel below — deliberately NOT reported as "unreachable"
// since that would misdiagnose an unrelated problem (e.g. no registry access)
// as the netavark-flush bug this check targets.
const REACHABILITY_PROBE_TIMEOUT_SENTINEL = 124;

export type ReachabilityClassification = "reachable" | "unreachable" | "inconclusive";

/** Pure: maps the probe container's exit code to a classification. */
export function classifyReachabilityProbeExit(code: number): ReachabilityClassification {
  if (code === 0) return "reachable";
  if (code === 1) return "unreachable";
  return "inconclusive";
}

/** Pure: the exact `podman run` argv for the reachability probe container. */
export function buildReachabilityProbeArgv(port: number): string[] {
  return [
    "podman",
    "run",
    "--rm",
    "--network",
    OPENSHELL_NETWORK_NAME,
    "--pull",
    "missing",
    REACHABILITY_PROBE_IMAGE,
    "sh",
    "-c",
    `nc -z -w 2 host.containers.internal ${port}`,
  ];
}

interface GatewayReachabilityIo {
  networkExists: () => Promise<boolean>;
  runProbe: () => Promise<number>;
  runReload: () => Promise<boolean>;
}

/** Pure decision tree over injected I/O — fully unit-testable without
 * spawning anything real. Covers: network not yet created, reachable,
 * inconclusive, unreachable+suggest-only (default), and unreachable+
 * auto-reload (network_auto_reload) in all its outcomes. */
export async function evaluateGatewayReachability(
  port: number,
  autoReloadEnabled: boolean,
  io: GatewayReachabilityIo,
): Promise<CheckOutcome> {
  if (!(await io.networkExists())) {
    return {
      ok: true,
      detail: `'${OPENSHELL_NETWORK_NAME}' podman network not found yet (no sandbox has run) — skipping`,
    };
  }

  const first = classifyReachabilityProbeExit(await io.runProbe());
  if (first === "reachable") return { ok: true };
  if (first === "inconclusive") {
    return { ok: true, detail: "reachability probe was inconclusive (couldn't run it); skipping" };
  }

  // first === "unreachable"
  if (!autoReloadEnabled) {
    return {
      ok: false,
      detail:
        `a container on the '${OPENSHELL_NETWORK_NAME}' network could not reach the gateway ` +
        `at host.containers.internal:${port} (a host firewall/network reload may have flushed ` +
        "netavark's NAT rules — see GH #75)",
      fix: "podman network reload --all",
    };
  }

  const reloadOk = await io.runReload();
  if (!reloadOk) {
    return {
      ok: false,
      detail:
        `gateway unreachable from the '${OPENSHELL_NETWORK_NAME}' network at ` +
        `host.containers.internal:${port}; network_auto_reload is enabled but ` +
        "`podman network reload --all` itself failed",
      fix: "run `podman network reload --all` manually and inspect its output",
    };
  }

  const after = classifyReachabilityProbeExit(await io.runProbe());
  if (after === "reachable") {
    return {
      ok: true,
      detail:
        `gateway was unreachable from the '${OPENSHELL_NETWORK_NAME}' network; auto-ran ` +
        "`podman network reload --all` (network_auto_reload) and it recovered",
    };
  }
  return {
    ok: false,
    detail:
      `gateway still unreachable from the '${OPENSHELL_NETWORK_NAME}' network at ` +
      `host.containers.internal:${port} after auto-running \`podman network reload --all\``,
    fix: "inspect podman network / firewall state manually (see GH #75)",
  };
}

async function podmanNetworkExists(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["podman", "network", "exists", name], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function runReachabilityProbeContainer(port: number): Promise<number> {
  try {
    const proc = Bun.spawn(buildReachabilityProbeArgv(port), {
      stdout: "ignore",
      stderr: "ignore",
    });
    let timedOut = false;
    // A dangling `Bun.sleep(...).then(...)` left un-cancelled after the probe
    // returns holds the event loop open in the compiled bun binary (the
    // documented compiled-vs-interpreter footgun) — `openlock doctor` would
    // hang up to REACHABILITY_PROBE_TIMEOUT_MS after it's otherwise done.
    // `.unref()` + clearing the timer in `finally` (whichever settles first —
    // normal exit or our own kill) ensures nothing dangles either way.
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, REACHABILITY_PROBE_TIMEOUT_MS).unref();
    try {
      const code = await proc.exited;
      return timedOut ? REACHABILITY_PROBE_TIMEOUT_SENTINEL : code;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return REACHABILITY_PROBE_TIMEOUT_SENTINEL;
  }
}

async function runNetworkReloadAll(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["podman", "network", "reload", "--all"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export type GatewayReachabilityProbe = (
  port: number,
  autoReloadEnabled: boolean,
) => Promise<CheckOutcome>;

async function defaultGatewayReachabilityProbe(
  port: number,
  autoReloadEnabled: boolean,
): Promise<CheckOutcome> {
  return evaluateGatewayReachability(port, autoReloadEnabled, {
    networkExists: () => podmanNetworkExists(OPENSHELL_NETWORK_NAME),
    runProbe: () => runReachabilityProbeContainer(port),
    runReload: () => runNetworkReloadAll(),
  });
}

/** Only meaningful when podman is in play AND a gateway is actually running —
 * gated eagerly (both are cheap sync/local checks) so the check is simply
 * absent otherwise, matching buildSubuidCheck's convention. This also keeps
 * it a no-op in test/CI runs, which don't start a real gateway. */
export function buildGatewayReachabilityCheck(
  hasPodman: boolean,
  gatewayRunning: boolean,
  gatewayPort: number,
  autoReloadEnabled: boolean,
  probe: GatewayReachabilityProbe = defaultGatewayReachabilityProbe,
): Check[] {
  if (!hasPodman || !gatewayRunning) return [];
  return [
    {
      name: `sandbox → gateway reachability (${OPENSHELL_NETWORK_NAME} network)`,
      test: () => probe(gatewayPort, autoReloadEnabled),
    },
  ];
}

export interface DoctorResult {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

async function checkGlobalConfig(): Promise<CheckOutcome> {
  try {
    const cfg = readGlobalConfig();
    if (cfg === null) {
      // openlock-ucm: readGlobalConfig() returns null (not a throw) when the
      // file — and its whole directory — simply doesn't exist yet, which is
      // the NORMAL state for a fresh install (defaults apply exactly as if
      // an empty file were present; see global-config/index.ts). That's not
      // an error, so this must stay ok:true. But the check's own name embeds
      // the path ("global config (<path>)"), and a label naming a path reads
      // as "this exists and is valid" when it renders green — a real user
      // during the 2026-07-31 clean-install verification read it exactly
      // that way. Surface the absent/valid distinction in the detail line
      // instead of the pass/fail bit, so a fresh install still shows all-green
      // (absent config is not a failure condition) while the status text
      // stays honest about what was actually found.
      return {
        ok: true,
        detail: "not present — using built-in defaults (normal for a fresh install)",
      };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg };
  }
}

/** Presence + readiness checks for a single installed runtime. */
function runtimeChecksFor(rt: Runtime, isMac: boolean): Check[] {
  const readiness: Check =
    rt === "podman"
      ? isMac
        ? {
            name: "podman machine (running)",
            test: podmanMachineRunning,
            fix: "podman machine start",
          }
        : {
            name: "podman API socket active",
            test: podmanSocketActive,
            fix: "systemctl --user enable --now podman.socket",
          }
      : {
          name: "docker daemon reachable",
          test: dockerDaemonReachable,
          fix: "start Docker (systemctl --user start docker, or launch Docker Desktop)",
        };
  return [
    {
      name: rt,
      test: async () => commandExists(rt),
      fix: rt === "podman" ? installHint("podman") : DOCKER_INSTALL_DOCS,
    },
    readiness,
  ];
}

// Small outcome-shape helpers used by asAmbiguousWarning below. `test()` can
// return either a bare boolean or a full CheckOutcome ({ok, detail?, fix?}) —
// these normalize across both without asAmbiguousWarning itself needing to
// branch on the union more than once.
function outcomeFailed(outcome: boolean | CheckOutcome): boolean {
  return typeof outcome === "boolean" ? !outcome : !outcome.ok;
}

function outcomeDetail(outcome: boolean | CheckOutcome): string | undefined {
  return typeof outcome === "boolean" ? undefined : outcome.detail;
}

function outcomeFix(outcome: boolean | CheckOutcome): string | undefined {
  return typeof outcome === "boolean" ? undefined : outcome.fix;
}

/** Builds the WARNING-shaped CheckOutcome asAmbiguousWarning falls back to
 * on a failing probe. Split out purely to keep asAmbiguousWarning's own
 * cognitive complexity under the linter's threshold — no behavior of its
 * own beyond string assembly. */
function buildAmbiguousWarningOutcome(
  rt: Runtime,
  outcome: boolean | CheckOutcome,
  fallbackFix: string | undefined,
): CheckOutcome {
  const innerDetail = outcomeDetail(outcome);
  const fix = outcomeFix(outcome) ?? fallbackFix;
  return {
    ok: true,
    detail:
      `WARNING: ${rt} does not look ready` +
      (innerDetail !== undefined ? ` (${innerDetail})` : "") +
      (fix !== undefined ? ` — fix: ${fix}` : "") +
      ". Not failing doctor because multiple runtimes are installed and none is selected yet " +
      `— set OPENLOCK_RUNTIME=${rt} (or another) or defaultRuntime in config once you've picked one.`,
  };
}

/** Runs an existing readiness Check's test, but never lets it report failure —
 * a failing probe renders as an ok:true check with an unmistakable
 * WARNING-prefixed detail line instead.
 *
 * openlock-ucm follow-up: the genuinely AMBIGUOUS case (≥2 runtimes
 * installed, none resolves — no OPENLOCK_RUNTIME, no configured
 * defaultRuntime, i.e. a fresh install with both podman and docker present)
 * used to skip readiness on both runtimes entirely, rendering an all-green
 * `doctor`. That's a false PASS: a user in exactly that state with a stopped
 * podman machine got a clean doctor run and then watched `openlock sandbox`
 * fail outright. This repo's v0.11.2 sweep theme was specifically "openlock
 * did the wrong thing silently while every surface reported success" — a
 * silently-skipped readiness check is that same failure mode wearing a
 * doctor costume. So in the ambiguous case we DO run every installed
 * runtime's readiness probe (see ambiguousRuntimeChecksFor below) — but a
 * failure there means "this particular runtime isn't ready", not "your
 * machine is broken", since the user hasn't told openlock which one they
 * even want yet. Reintroducing a real failure here would re-open
 * openlock-ucm (that fix's whole point was to stop failing doctor over a
 * runtime nobody selected), so it must warn, never fail — hence this wrapper
 * forces ok:true unconditionally while keeping the underlying detail/fix
 * text visible (renderDoctorResults only prints `fix:` for actual failures,
 * so any actionable fix text has to be folded into the detail line to
 * survive here). */
export function asAmbiguousWarning(rt: Runtime, inner: Check): Check {
  return {
    name: inner.name,
    test: async () => {
      const outcome = await inner.test();
      if (!outcomeFailed(outcome)) return typeof outcome === "boolean" ? { ok: true } : outcome;
      return buildAmbiguousWarningOutcome(rt, outcome, inner.fix);
    },
  };
}

/** Presence + readiness for a single installed runtime IN THE AMBIGUOUS CASE
 * (see asAmbiguousWarning): unlike runtimeChecksFor's normal readiness check,
 * this one can never fail doctor's exit code — a failing probe still shows
 * up, just as a warning. */
function ambiguousRuntimeChecksFor(rt: Runtime, isMac: boolean): Check[] {
  const [presence, readiness] = runtimeChecksFor(rt, isMac);
  return [presence, asAmbiguousWarning(rt, readiness)];
}

/** Report EVERY installed runtime's presence, but gate hard-FAILING readiness
 * (podman machine running / docker daemon reachable) on the RESOLVED runtime
 * only (openlock-ucm).
 *
 * Before that fix, a host with both the docker CLI and podman installed —
 * extremely common on a Mac, since Docker Desktop puts `docker` on PATH
 * whether or not it's running — got a readiness check for EVERY installed
 * runtime, so `openlock doctor` failed on "docker daemon reachable" even
 * when podman (the runtime openlock actually resolved and would use) was
 * fully healthy. That's the documented golden path's very first command
 * (README: install → doctor → init → validate → sandbox) reporting failure
 * on a genuinely healthy machine, which also hard-stops any scripted
 * `openlock doctor && openlock init ...`.
 *
 * Still surfacing presence for non-resolved runtimes (rather than omitting
 * them outright) keeps the check "genuinely useful info, not just deleted" —
 * a user with two runtimes installed can see both and see which one
 * openlock picked, without a stale daemon on the unused one ever counting
 * against them.
 *
 * A host with both installed and neither auto-resolvable (resolvedRuntime is
 * null) is the ambiguous case above: readiness IS probed for both, but as a
 * non-failing warning rather than skipped outright or hard-failed. */
export function buildRuntimeChecks(
  probes: BinaryProbes,
  isMac: boolean,
  resolvedRuntime: Runtime | null,
): Check[] {
  const present = RUNTIMES.filter((r) => probes[r]);
  if (present.length === 0) {
    return [
      {
        name: "container runtime (podman/docker)",
        test: async () => false,
        fix: `${installHint("podman")}, or install docker: ${DOCKER_INSTALL_DOCS}`,
      },
    ];
  }
  return present.flatMap((r): Check[] => {
    if (r === resolvedRuntime) return runtimeChecksFor(r, isMac);
    if (resolvedRuntime === null) return ambiguousRuntimeChecksFor(r, isMac);
    return [
      {
        name: r,
        test: async () => ({
          ok: true,
          detail: `installed, but not in use (resolved runtime is ${resolvedRuntime}); readiness not checked`,
        }),
      },
    ];
  });
}

/** Rootless podman (Linux only): verify the host subuid range covers SANDBOX_UID.
 * Returns an empty array on macOS, when podman is not the runtime, or when running
 * as root (rootful podman doesn't use subuid maps, so the check would false-fire). */
export function buildSubuidCheck(
  hasPodman: boolean,
  isMac: boolean,
  readSubuid: () => string,
  isRoot: boolean,
): Check[] {
  if (!hasPodman || isMac || isRoot) return [];
  return [
    {
      name: "rootless podman subuid range",
      test: (): Promise<CheckOutcome> => {
        const user = os.userInfo().username || process.env.USER || process.env.LOGNAME || "";
        const content = readSubuid();
        const ok = rangeCoversUid(content, user, SANDBOX_UID);
        return Promise.resolve(
          ok
            ? { ok: true }
            : {
                ok: false,
                detail: `subuid count for '${user}' must exceed ${SANDBOX_UID} (keep-id:uid=${SANDBOX_UID} mapping)`,
                fix: SUBUID_FIX,
              },
        );
      },
    },
  ];
}

/** Dev-mode-only: building the gateway from source (`openshell-server` ->
 * `openshell-prover` -> `z3-sys`, since the 2026-06 sync) invokes bundled-z3's
 * CMake build. Without `cmake` on PATH the failure surfaces deep inside a long
 * `cargo build` — other crates keep compiling first, so it reads as normal
 * progress until it dies late with a cryptic "is cmake not installed?" — this
 * check catches it up front instead. A released-binary (non-dev) install never
 * builds anything, so the check is entirely absent outside dev mode.
 *
 * No separate C/C++ toolchain check: any dev-mode cargo build already needs a
 * linker, so a working C compiler is exercised (and would already be failing
 * doctor's `cargo`-adjacent build path) well before cmake becomes relevant —
 * adding a dedicated check here would just be a second, less accurate probe
 * for something already implied. */
export function buildCmakeCheck(dev: boolean, hasCmake: boolean): Check[] {
  if (!dev) return [];
  return [
    {
      name: "cmake",
      test: async () => hasCmake,
      fix: `${installHint("cmake")} (required to build the gateway's bundled z3 dependency in dev mode)`,
    },
  ];
}

// A malformed config.yaml is reported separately by the "global config" check
// below; don't let it crash doctor here too — just fall back to the
// suggest-only default (matches network_auto_reload's documented default).
function readNetworkAutoReload(): boolean {
  try {
    return readGlobalConfig()?.networkAutoReload ?? false;
  } catch {
    return false;
  }
}

export async function runDoctorChecks(
  runtime?: Runtime | null,
  readSubuid: () => string = defaultReadSubuid,
): Promise<DoctorResult[]> {
  // No explicit runtime (standalone `openlock doctor`, report) → probe both and
  // report every installed runtime. An explicit runtime (e.g. session preflight,
  // where it's already resolved) narrows to that one; explicit null → no runtime.
  const probes: BinaryProbes =
    runtime === undefined
      ? { podman: commandExists("podman"), docker: commandExists("docker") }
      : { podman: runtime === "podman", docker: runtime === "docker" };
  const isMac = process.platform === "darwin";
  const dev = isDevMode();

  // openlock-ucm: figure out which runtime is actually going to be used so
  // readiness-style checks below can gate on THAT one, not merely on "is it
  // installed". An explicit `runtime` argument (session preflight, which has
  // already run the real resolveRuntime()) IS the resolved runtime — trust it
  // directly rather than re-resolving, and note the `probes` computed just
  // above already narrow to that single runtime in that case, so nothing
  // below changes behavior for that call path. Standalone `openlock doctor`/
  // `openlock report` (runtime === undefined) haven't resolved anything yet;
  // resolveRuntimeNonInteractive mirrors what `openlock sandbox` would pick
  // (env var > config default > single-binary autodetect) WITHOUT ever
  // launching the interactive runtime picker — doctor must stay a pure,
  // side-effect-free read, and report.ts can run unattended in CI/scripts.
  // It returns null when resolution is genuinely ambiguous (both installed,
  // no default configured) or nothing is installed; buildRuntimeChecks/
  // buildSubuidCheck/buildGatewayReachabilityCheck all treat null as "don't
  // gate on anything" rather than guessing.
  const resolvedRuntime = runtime === undefined ? await resolveRuntimeNonInteractive() : runtime;
  const podmanIsResolved = resolvedRuntime === "podman";

  const runtimeChecks = buildRuntimeChecks(probes, isMac, resolvedRuntime);
  // Rootless podman (Linux only) requires the host's subuid range to cover
  // the in-image sandbox UID so `--userns=keep-id:uid=N` can map it. Gated on
  // podman being the RESOLVED runtime, not merely installed (openlock-ucm) —
  // a Linux box with podman on PATH but docker actually in use shouldn't fail
  // doctor over a podman subuid range nobody's relying on.
  const subuidChecks = buildSubuidCheck(
    podmanIsResolved,
    isMac,
    readSubuid,
    process.getuid?.() === 0,
  );
  // Same principle: this probe spins up a real podman container to test
  // sandbox->gateway reachability on podman's network — meaningless (and
  // wasted work) unless podman is the runtime actually in play.
  const reachabilityChecks = buildGatewayReachabilityCheck(
    podmanIsResolved,
    gatewayStatus().running,
    GATEWAY_PORT,
    readNetworkAutoReload(),
  );

  const checks: Check[] = [
    { name: "git", test: async () => commandExists("git"), fix: installHint("git") },
    ...runtimeChecks,
    ...subuidChecks,
    ...reachabilityChecks,
    ...(dev
      ? [
          {
            name: "bun",
            test: async () => commandExists("bun"),
            fix: "curl -fsSL https://bun.sh/install | bash",
          },
          {
            name: "cargo",
            test: async () => commandExists("cargo"),
            fix: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
          },
          ...buildCmakeCheck(dev, commandExists("cmake")),
          ...(isMac
            ? [
                {
                  name: "cargo-zigbuild",
                  test: async () => commandExists("cargo-zigbuild"),
                  fix: "cargo install cargo-zigbuild",
                },
              ]
            : []),
          {
            name: "openshell-fork directory",
            test: async () => existsSync(join(forkDir(), ".git")),
            fix: `clone the openshell fork into ${forkDir()} (dev setup)`,
          },
        ]
      : []),
    {
      name: "credentials (openlock login)",
      test: async () => hasAnyProvider(),
      fix: "openlock login",
    },
    {
      name: `global config (${globalConfigPath()})`,
      test: checkGlobalConfig,
      fix: `edit or remove ${globalConfigPath()}`,
    },
  ];

  const results: DoctorResult[] = [];
  for (const c of checks) {
    const outcome = await c.test();
    const co = typeof outcome === "boolean" ? undefined : outcome;
    const r: DoctorResult = {
      name: c.name,
      ok: typeof outcome === "boolean" ? outcome : outcome.ok,
    };
    if (co?.detail !== undefined) r.detail = co.detail;
    const fix = co?.fix ?? c.fix;
    if (fix !== undefined) r.fix = fix;
    results.push(r);
  }
  return results;
}

/** Render doctor results to display lines + a failure count. Pure (no I/O) so
 * the formatting — notably that `fix:` prints only for failed checks — is unit
 * testable without `doctor()`'s `process.exit`. */
export function renderDoctorResults(results: DoctorResult[]): {
  lines: string[];
  failures: number;
} {
  const lines: string[] = [];
  let failures = 0;
  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    lines.push(`  ${icon} ${r.name}`);
    if (r.detail !== undefined) lines.push(`      ${r.detail}`);
    if (!r.ok && r.fix !== undefined) lines.push(`      fix: ${r.fix}`);
    if (!r.ok) failures++;
  }
  return { lines, failures };
}

export async function doctor(): Promise<void> {
  const results = await runDoctorChecks();
  const { lines, failures } = renderDoctorResults(results);
  for (const line of lines) console.log(line);

  console.log();
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("All checks passed.");
  }
}
