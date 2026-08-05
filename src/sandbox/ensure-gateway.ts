import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { defaultStateDir, resolveStateDir } from "../paths";
import { parseRuntime, type Runtime, resolveRuntime } from "../runtime";
import { ensureSupervisorImage } from "./build-supervisor-image";
import { getGatewayBinary } from "./fork-binaries";
import { pidAlive } from "./proc";

function pidFile(stateDir: string): string {
  return join(stateDir, "gateway.pid");
}
// Driver the RUNNING gateway was started with (openlock-ox1). Written
// alongside the pid file at every gateway start; absent means either the
// gateway isn't running or (if it IS running) it was started by a version
// of openlock that predates this file — either way, "unknown", never a
// mismatch. Deliberately a separate file rather than folding into the pid
// file (a bare integer read/relied on in several places) to keep this
// additive and not touch that format.
function driverFile(stateDir: string): string {
  return join(stateDir, "gateway.driver");
}
function logFile(stateDir: string): string {
  return join(stateDir, "gateway.log");
}
// gateway.log is appended to forever across gateway restarts (openlock-lai:
// observed at 100MB, unrotated). Rotate at (re)start time — the only moment
// openlock touches the file — keeping exactly one backup generation.
const GATEWAY_LOG_MAX_BYTES = 10 * 1024 * 1024;
function configFile(stateDir: string): string {
  return join(stateDir, "gateway-config.toml");
}
// Sandbox-JWT signing material. Since upstream #1404 the sandbox supervisor
// requires a gateway-minted JWT to fetch its policy — without one it exits
// during provisioning. The gateway mints per-sandbox tokens only when this
// bundle is present, so we generate it once and point the gateway at it.
function pkiDir(stateDir: string): string {
  return join(stateDir, "pki");
}
function jwtSigningKey(stateDir: string): string {
  return join(pkiDir(stateDir), "jwt", "signing.pem");
}
function jwtPublicKey(stateDir: string): string {
  return join(pkiDir(stateDir), "jwt", "public.pem");
}
function jwtKid(stateDir: string): string {
  return join(pkiDir(stateDir), "jwt", "kid");
}
/** Persisted CACHE of the port a gateway started from `stateDir` last bound
 * to (openlock-x8m8) — written alongside the pid/driver files purely for
 * observability (`cat .../gateway.port`, and `openlock doctor`'s mismatch
 * check below). NEVER the authority: `resolveGatewayPort`, recomputed fresh
 * from the CURRENT state dir, is what every operational decision uses. See
 * `findGatewayPortRecordMismatch`. */
function portFile(stateDir: string): string {
  return join(stateDir, "gateway.port");
}

export const GATEWAY_PORT = 18081;
// Historical name from the podman-only era; now drives podman OR docker per
// `--drivers` resolution. Kept stable so existing on-disk state under
// `~/.config/openshell/gateways/podman-dev/` stays valid. Revisit at v1.0.
export const GATEWAY_NAME = "podman-dev";

const DEFAULT_SANDBOX_IMAGE = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest";

// Private port band for a RELOCATED state dir (openlock-x8m8): 18082-18999,
// ~900 slots, adjacent to the historical fixed GATEWAY_PORT. Deliberately
// clear of both platforms' ephemeral port ranges (Linux 32768-60999, macOS
// 49152-65535) — binding inside either would make the gateway intermittently
// collide with transient outbound sockets.
const DERIVED_PORT_BAND_START = 18082;
const DERIVED_PORT_BAND_SIZE = 918; // 18082..18999 inclusive

/**
 * The gateway port for a given (already-resolved) state dir (openlock-x8m8:
 * isolating `$HOME`/`OPENLOCK_STATE_DIR` per project/CI run is pointless if
 * every isolated instance still fights over the one fixed port).
 *
 * - The DEFAULT state dir ALWAYS maps to `GATEWAY_PORT` (18081), byte-for-
 *   byte identical to pre-x8m8 behavior. Hashing the default dir would move
 *   every existing user's gateway port: it would orphan their already-
 *   running gateway (openlock-k5j2's foreign-gateway refusal would then fire
 *   against their OWN gateway), stale
 *   `~/.config/openshell/gateways/podman-dev/metadata.json`'s
 *   `gateway_endpoint` (see registerGatewayMetadata), and make
 *   `openlock doctor` / the install docs report the wrong port.
 * - A RELOCATED state dir (`OPENLOCK_STATE_DIR` pointed elsewhere) gets a
 *   port deterministically derived from the canonicalized dir path — same
 *   path in, same port out, across runs and machines, with no scan-and-
 *   persist coordination needed.
 *
 * Collisions within the derived band (two different relocated state dirs
 * hashing to the same port) are possible and already LOUD: openlock-k5j2
 * (PR #134) refuses to adopt a foreign gateway found answering the port
 * instead of the child this invocation just spawned. This function
 * deliberately builds no second collision-avoidance mechanism on top of
 * that existing refusal.
 */
export function resolveGatewayPort(stateDir: string): number {
  const resolved = resolvePath(stateDir);
  if (resolved === resolvePath(defaultStateDir())) return GATEWAY_PORT;
  const hash = createHash("sha256").update(resolved).digest();
  return DERIVED_PORT_BAND_START + (hash.readUInt32BE(0) % DERIVED_PORT_BAND_SIZE);
}

/** Reads the persisted port record (see `portFile`) for `stateDir`, or
 * `undefined` when absent/unparseable — no gateway has ever started from
 * this state dir, or it's a pre-x8m8 one that never wrote the file. Never
 * throws. */
export function readGatewayPortRecord(stateDir: string): number | undefined {
  try {
    const raw = readFileSync(portFile(stateDir), "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

/**
 * Whether a persisted port record disagrees with what `stateDir` currently
 * derives (openlock-x8m8). Returns the stale recorded port (for the
 * message), or `null` when there's nothing to report — including when
 * `recorded` is `undefined` (no record yet, never a false positive). Mirrors
 * `findGatewayDriverMismatch`'s exact shape.
 *
 * The record is a CACHE for observability, never the authority — `derived`
 * always wins for any operational decision (what port to start on, what
 * port to probe). A disagreement means the state dir's resolved path
 * changed identity (moved, or `OPENLOCK_STATE_DIR` repointed) AFTER the
 * currently-recorded gateway was started; it's surfaced as a doctor warning
 * rather than acted on automatically.
 */
export function findGatewayPortRecordMismatch(
  recorded: number | undefined,
  derived: number,
): number | null {
  if (recorded === undefined) return null;
  return recorded !== derived ? recorded : null;
}

function readPid(stateDir: string): number | null {
  const path = pidFile(stateDir);
  if (!existsSync(path)) return null;
  const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

/** Driver recorded for the currently-running gateway (openlock-ox1), or
 * `undefined` when the file is absent/unparseable — treated as "unknown",
 * never coerced to a guess. See `driverFile`'s own comment for why absence
 * is expected and safe (legacy gateway, or simply not running). */
function readRunningDriver(stateDir: string): Runtime | undefined {
  const path = driverFile(stateDir);
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8").trim();
  } catch {
    return undefined;
  }
  return parseRuntime(raw) ?? undefined;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
  rssKb?: number;
  uptimeMs?: number;
  /** Driver ('podman'|'docker') the RUNNING gateway was started with
   * (openlock-ox1). `undefined` when not running, OR when running but
   * started before driver-recording existed — both are "can't tell", never
   * a false mismatch signal. See findGatewayDriverMismatch. */
  driver?: Runtime;
  /** The gateway port for the CURRENTLY RESOLVED state dir (openlock-x8m8).
   * Always present (computed fresh via `resolveGatewayPort` regardless of
   * `running`) — 18081 for the default state dir, a derived value for a
   * relocated one (`OPENLOCK_STATE_DIR`). */
  port: number;
}

export function readGatewayRssKb(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (out.length === 0) return null;
  const kb = parseInt(out, 10);
  return Number.isNaN(kb) ? null : kb;
}

// KNOWN GAP, noted not fixed here (openlock-k5j2 spike, to be filed
// separately): the ONLY liveness signal below is `pidAlive(pid)` — a
// gateway process that is alive but has somehow lost its listening socket
// (crashed accept loop, killed and replaced by an unrelated process that
// reused the pid, etc.) still reports `running: true` here, and every
// downstream sandbox operation then fails against a gateway this function
// swears is healthy. `startGateway`'s new post-spawn checks (below) close
// the "silently adopted a FOREIGN gateway" half of this defect family;
// they do not close this "silently trusts a dead-but-pid-alive gateway"
// half, since that requires gatewayStatus() itself to probe the socket
// (today it never touches GATEWAY_PORT at all).
export function gatewayStatus(): GatewayStatus {
  const stateDir = resolveStateDir();
  const port = resolveGatewayPort(stateDir);
  const pid = readPid(stateDir);
  if (pid === null) return { running: false, pid: null, port };
  if (!pidAlive(pid)) {
    unlinkSync(pidFile(stateDir));
    return { running: false, pid: null, port };
  }
  const rssKb = readGatewayRssKb(pid) ?? undefined;
  let uptimeMs: number | undefined;
  try {
    const stat = statSync(pidFile(stateDir));
    uptimeMs = Date.now() - stat.mtimeMs;
  } catch {
    uptimeMs = undefined;
  }
  const driver = readRunningDriver(stateDir);
  return { running: true, pid, rssKb, uptimeMs, driver, port };
}

/**
 * Pids holding the LISTEN socket on `port` (openlock-k5j2). Deliberately
 * NOT `lsof -ti :<port>` — that flag combination returns the listener AND
 * every connected CLIENT of that port. Verified against a real running
 * gateway: `lsof -ti :18081` returned three pids, of which only one was
 * actually the gateway (the other two were connected clients) — comparing
 * against just the first line of that output would false-positive a
 * mismatch against a perfectly healthy gateway. `-sTCP:LISTEN` restricts
 * the match to the actual listening socket; `-nP` skips DNS/service-name
 * lookups (irrelevant here, but avoids surprising hangs on a broken
 * resolver). Callers MUST compare by set membership, never index-0
 * equality.
 *
 * Returns `null` when the probe itself couldn't run (e.g. `lsof` missing —
 * this is the COMMON case on the project's own ubuntu-24.04 CI runner,
 * not confirmed present there) — that means "inconclusive," never "nothing
 * is listening." An empty (non-null) array is a real, meaningful "nothing
 * is listening on this port right now," distinct from "couldn't tell."
 * Every caller must treat `null` as "skip this check," not as evidence of
 * either a match or a mismatch — same discipline as `readRunningDriver`.
 */
export function getListeningPids(
  port: number,
  probe: (port: number) => number[] | null = realLsofListenProbe,
): number[] | null {
  return probe(port);
}

function realLsofListenProbe(port: number): number[] | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["lsof", "-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null; // lsof not on PATH (or failed to spawn at all)
  }
  // lsof exits 1 when nothing matches the filter — that IS a real "no
  // listener" result, not a probe failure, so it must not fold into null
  // alongside genuine spawn/exec failures (any other non-zero exit).
  if (proc.exitCode !== 0 && proc.exitCode !== 1) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (out.length === 0) return [];
  return out
    .split("\n")
    .map((line) => parseInt(line.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

function registerGatewayMetadata(port: number): void {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME || homedir(), ".config");
  const gatewayDir = join(configHome, "openshell", "gateways", GATEWAY_NAME);
  mkdirSync(gatewayDir, { recursive: true });

  writeFileSync(
    join(gatewayDir, "metadata.json"),
    JSON.stringify({
      name: GATEWAY_NAME,
      gateway_endpoint: `http://127.0.0.1:${port}`,
      is_remote: false,
      gateway_port: port,
      auth_mode: "plaintext",
    }),
  );

  const activeGatewayPath = join(configHome, "openshell", "active_gateway");
  writeFileSync(activeGatewayPath, GATEWAY_NAME);
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function renderGatewayConfigToml(
  runtime: Runtime,
  opts: {
    supervisorImage: string;
    podmanSocket?: string;
    gatewayJwt?: { signingKeyPath: string; publicKeyPath: string; kidPath: string };
  },
): string {
  const lines = ["[openshell]", "version = 1", ""];
  if (opts.gatewayJwt) {
    // Configuring the sandbox-JWT issuer activates the gateway's auth chain,
    // which would otherwise reject openlock's own (credential-less) CLI calls.
    // openlock is a single-user local gateway, so accept unauthenticated CLI
    // callers as a local developer principal; sandbox supervisors continue to
    // present their gateway-minted JWTs.
    lines.push(
      "[openshell.gateway.auth]",
      "allow_unauthenticated_users = true",
      "",
      "[openshell.gateway.gateway_jwt]",
      `signing_key_path = "${tomlEscape(opts.gatewayJwt.signingKeyPath)}"`,
      `public_key_path = "${tomlEscape(opts.gatewayJwt.publicKeyPath)}"`,
      `kid_path = "${tomlEscape(opts.gatewayJwt.kidPath)}"`,
      // openlock-4b1 / GH #75: never-expire local sandbox JWTs is a FORK
      // DEFAULT (default_sandbox_token_ttl_secs() in openshell-core's
      // GatewayJwtConfig, currently 0), not something openlock has ever
      // pinned. We depend on 0 (a sandbox stopped >1h must still resume
      // without ExpiredSignature) — pin it explicitly so a future upstream
      // sync flipping that default can't silently resurrect the bug.
      "ttl_secs = 0",
      "",
    );
  }
  if (runtime === "podman") {
    if (!opts.podmanSocket) {
      throw new Error("podmanSocket required for podman runtime");
    }
    lines.push(
      "[openshell.drivers.podman]",
      `default_image = "${tomlEscape(DEFAULT_SANDBOX_IMAGE)}"`,
      `supervisor_image = "${tomlEscape(opts.supervisorImage)}"`,
      `socket_path = "${tomlEscape(opts.podmanSocket)}"`,
      // Upstream gates driver-config bind mounts behind an operator flag that
      // defaults to false; without it the driver hard-errors with "podman bind
      // mounts require enable_bind_mounts = true". openlock already exposes
      // host bind mounts via `--volume`, so this grants no capability users
      // don't have today — it just satisfies the gate.
      "enable_bind_mounts = true",
      "",
    );
  } else {
    lines.push(
      "[openshell.drivers.docker]",
      `default_image = "${tomlEscape(DEFAULT_SANDBOX_IMAGE)}"`,
      `supervisor_image = "${tomlEscape(opts.supervisorImage)}"`,
      // See the podman block above — docker has the identical gate.
      "enable_bind_mounts = true",
      "",
    );
  }
  return lines.join("\n");
}

function writeGatewayConfigFile(
  path: string,
  opts: {
    runtime: Runtime;
    supervisorImage: string;
    podmanSocket?: string;
    gatewayJwt?: { signingKeyPath: string; publicKeyPath: string; kidPath: string };
  },
): void {
  writeFileSync(path, renderGatewayConfigToml(opts.runtime, opts));
}

// Generate the sandbox-JWT signing bundle if absent. Idempotent: the gateway's
// `generate-certs` skips when the files already exist. Also emits an (unused)
// TLS bundle alongside the JWT material, which is harmless under --disable-tls.
async function ensureSandboxJwtMaterial(gatewayBin: string, stateDir: string): Promise<void> {
  if (
    existsSync(jwtSigningKey(stateDir)) &&
    existsSync(jwtPublicKey(stateDir)) &&
    existsSync(jwtKid(stateDir))
  ) {
    return;
  }
  const proc = Bun.spawn([gatewayBin, "generate-certs", "--output-dir", pkiDir(stateDir)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Failed to generate sandbox JWT material: ${err.trim()}`);
  }
}

async function resolvePodmanSocket(): Promise<string> {
  // macOS routes podman through a VM; the host-visible socket only exists in
  // `podman machine inspect`. On Linux podman runs directly on the host, so
  // `podman info` returns the real socket path.
  if (process.platform === "linux") {
    const proc = Bun.spawn(["podman", "info", "--format", "{{.Host.RemoteSocket.Path}}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error("Failed to resolve Podman socket path via `podman info`");
    }
    return out.trim().replace(/^unix:\/\//, "");
  }
  const proc = Bun.spawn(
    ["podman", "machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error("Failed to resolve Podman socket path via `podman machine inspect`");
  }
  return out.trim();
}

// Rotate `logPath` to `logPath.1` (overwriting any prior `.1`) if it exists
// and has grown to `maxBytes` or larger. One backup generation only — not
// N. No-ops when the file doesn't exist (first run) or is under threshold.
// Rotation failures never block gateway startup: at most a warning is
// logged and the (possibly oversized) file is left as-is for `openSync`'s
// append to continue against.
export function rotateLogIfLarge(logPath: string, maxBytes: number): void {
  try {
    if (!existsSync(logPath)) return;
    if (statSync(logPath).size < maxBytes) return;
    renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    console.warn(
      `Warning: failed to rotate gateway log at ${logPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function spawnDaemonToLog(args: string[], cwd: string, logPath: string): { pid: number } {
  const logFd = openSync(logPath, "a");
  try {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: logFd,
      stderr: logFd,
      // Without this, the gateway shares the CLI's process group/session
      // (Bun.spawn defaults to detached: false), so it's only insulated from
      // the parent by unref() *not* holding the event loop open — nothing
      // stops a SIGHUP delivered to that session (e.g. the CLI process exits
      // as its session leader, as commonly happens for a short-lived
      // scripted/CI `--no-attach` invocation with no surviving controlling
      // terminal) from also killing the gateway. `detached: true` calls
      // setsid() so the gateway becomes its own session/process-group leader,
      // immune to signals delivered to the CLI's session — verified via
      // `ps -o pgid=` in spawnDaemonToLog's test (openlock-ab6). Interactive
      // attach-and-exit didn't show this because a human's shell keeps the
      // terminal session alive across the CLI exiting, so no SIGHUP cascade
      // ever fired in that pattern — same latent bug, different exposure.
      detached: true,
    });
    // The gateway is a daemon — don't hold the parent CLI's event loop open
    // after this function returns. `bun src/cli.ts` (interpreter) auto-exits
    // when the script ends; `bun build --compile`d binaries don't, so the
    // parent hangs after "Gateway ready." until the child dies.
    proc.unref();
    return { pid: proc.pid };
  } finally {
    closeSync(logFd);
  }
}

/**
 * Whether starting a gateway for `requestedRuntime` would silently reuse an
 * ALREADY-RUNNING gateway started with a DIFFERENT driver (openlock-ox1).
 * Returns the mismatched running driver (for the error message), or `null`
 * when there's no mismatch — including when `runningDriver` is `undefined`
 * (a gateway started before driver-recording existed, or any other reason
 * we can't tell). Same "absent means unknown, never a false positive"
 * discipline as openlock-04t's findUnattachedCredentialBundles: an unknown
 * driver must never be treated as either "matches" or "definitely wrong".
 *
 * Only meaningful when a gateway IS running — callers gate on that
 * themselves (this function has no opinion on liveness).
 */
export function findGatewayDriverMismatch(
  requestedRuntime: Runtime,
  runningDriver: Runtime | undefined,
): Runtime | null {
  if (runningDriver === undefined) return null;
  return runningDriver !== requestedRuntime ? runningDriver : null;
}

/**
 * Error message for a detected driver mismatch (openlock-ox1) — names BOTH
 * drivers (the running one and the one actually requested) and points at
 * the fix. Deliberately does NOT offer to restart the gateway automatically:
 * that would tear down every sandbox belonging to the currently-running
 * driver out from under whoever created them, for a request that never
 * asked for that. Hard error (not a warning) because the class of failure —
 * silently ignoring an explicit user directive — is the same one this
 * project already refuses for provider selection (no inference, no magic
 * fallback: explicit or error), and unlike credential-bundle drift
 * (openlock-04t, which warns) there is no "still works, just missing one
 * thing" reading here: the ENTIRE sandbox would silently run on the wrong
 * driver.
 */
export function formatGatewayDriverMismatchError(
  requestedRuntime: Runtime,
  runningDriver: Runtime,
): string {
  return (
    `Gateway is running with driver '${runningDriver}', but '${requestedRuntime}' was requested ` +
    "(OPENLOCK_RUNTIME env var or config default_runtime). Run `openlock gateway stop` first, then " +
    `retry — the gateway is not restarted automatically here, since that would tear down any sandboxes ` +
    `still running under the '${runningDriver}' driver.`
  );
}

/**
 * Message for openlock-k5j2's actual exhibited bug: a gateway answered THIS
 * invocation's readiness probe, but concrete evidence (our own spawned
 * child no longer alive, or the port's real LISTEN-socket owner excluding
 * our child's pid) shows it isn't the process we just started.
 *
 * Deliberately a DIFFERENT message from formatGatewayDriverMismatchError:
 * that one means "MY OWN previously-recorded gateway (this state dir's own
 * pid/driver files) has a different driver than now requested," and
 * its remedy (`openlock gateway stop`) is correct there, because this
 * state dir genuinely owns that gateway. Here, this invocation never owned
 * anything on the port at all — telling the user to stop "their" gateway
 * would point at state they may not even be able to reach (e.g. a
 * different $HOME's gateway holding the port).
 */
export function formatForeignGatewayAdoptionError(port: number, detail: string): string {
  return (
    `Gateway did not start: ${detail}, but 127.0.0.1:${port} is answering anyway — that is a ` +
    `DIFFERENT gateway this invocation does not own (a different $HOME, or another instance ` +
    `already holding the port). Refusing to adopt it.`
  );
}

export type ReadinessOutcome =
  | "not-ready"
  | "ready"
  | "foreign-dead-child"
  | "foreign-lsof-mismatch";

/**
 * Pure decision for one readiness-loop iteration (openlock-k5j2). Extracted
 * so the exact race this bug hinges on — `fetchOk: true, childAlive:
 * false` — is exhaustively unit tested without spawning a real gateway
 * process. Mirrors this file's `classifyProcNetTcpBind`: a pure classifier
 * fed by real-but-injected probe results, called from the actual I/O loop
 * in `startGateway`.
 *
 * - "not-ready": the HTTP probe itself didn't succeed this iteration — keep
 *   looping, no identity question arises yet.
 * - "foreign-dead-child": the probe succeeded, but our own spawned child
 *   (`gwPid`) is no longer alive. A responding probe therefore did NOT come
 *   from our child — some OTHER process already held the port. This is the
 *   exhibited bug: a bind failure on an already-occupied port lets a
 *   pre-existing, foreign gateway answer the readiness fetch while our own
 *   child silently died in the interval between this iteration's earlier
 *   liveness check and the fetch resolving.
 * - "foreign-lsof-mismatch": the child IS alive, but `listeningPids` (when
 *   available) doesn't include it — the child is running yet not bound to
 *   the port, so something else is answering instead. `listeningPids:
 *   null` (lsof unavailable — the common case on the project's own CI
 *   runner) can never produce this outcome; an inconclusive probe must not
 *   be able to fail a healthy start.
 * - "ready": the child is alive, and either lsof confirms it owns the
 *   listening socket or the probe was inconclusive.
 */
export function classifyReadinessOutcome(input: {
  fetchOk: boolean;
  childAlive: boolean;
  gwPid: number;
  listeningPids: number[] | null;
}): ReadinessOutcome {
  if (!input.fetchOk) return "not-ready";
  if (!input.childAlive) return "foreign-dead-child";
  if (input.listeningPids !== null && !input.listeningPids.includes(input.gwPid)) {
    return "foreign-lsof-mismatch";
  }
  return "ready";
}

/**
 * openlock-k5j2: warn-only strengthening signal for `startGateway`'s
 * already-running branch. This branch is what every real user hits on
 * every `gateway start`/`sandbox create` once a gateway is already up, so
 * an inconclusive OR even a genuinely stale probe must never brick a
 * working gateway. Contrast with `refuseForeignGatewayAdoption` below: that
 * one fires post-spawn, where THIS SAME invocation just watched its own
 * child die (or fail to own the socket) with its own eyes — an unambiguous
 * signal. Here we're only cross-checking a locally-recorded pid number
 * against a point-in-time lsof snapshot — real but weaker evidence, and
 * `lsof` is not confirmed present on the project's own ubuntu-24.04 CI
 * runner, so `null` is the COMMON case there, not the exception. Extracted
 * out of `startGateway` to keep its cognitive complexity in bounds.
 */
function warnIfRecordedGatewayPidMismatch(pid: number, port: number): void {
  const listeningPids = getListeningPids(port);
  if (listeningPids === null || listeningPids.includes(pid)) return;
  console.warn(
    `Warning: pid ${pid} is recorded as the gateway, but 127.0.0.1:${port}'s actual listener is ` +
      `pid(s) ${listeningPids.join(", ") || "(none)"} — the recorded pid may be stale (pid reuse) ` +
      `or a different gateway holds the port now. Proceeding, since the recorded gateway otherwise ` +
      `looks alive; run \`openlock gateway stop\` then \`openlock gateway start\` if sandbox ` +
      `operations start failing.`,
  );
}

/**
 * Removes the pid/driver/port triple this invocation wrote at the top of
 * `startGateway` (openlock-u60k). All three describe a gateway this
 * invocation believed it just started; once that belief is retracted —
 * confirmed-dead child, confirmed-foreign port owner — the files are stale
 * and must go with it, or a later `gatewayStatus()`/`openlock doctor` read
 * describes a process that never successfully started. Shared by both
 * `refuseForeignGatewayAdoption` and the "exited unexpectedly" branch below
 * it in `waitForGatewayReady`: those were the two abort paths that had
 * grown inconsistent about this cleanup (only the foreign-adoption one did
 * it) — factored out so there's one place both draw from instead of two
 * copies that can drift again. Deliberately NOT used by the 30s-timeout
 * branch further down: that one can fire with the child still ALIVE, where
 * the pid file is accurate and deleting it would orphan a live gateway. No
 * behavioral bite today either way — every reader re-checks `pidAlive()`
 * before trusting these files — this just keeps the two confirmed-dead
 * paths honest with each other.
 */
export function clearGatewayStateFiles(stateDir: string): void {
  if (existsSync(pidFile(stateDir))) unlinkSync(pidFile(stateDir));
  if (existsSync(driverFile(stateDir))) unlinkSync(driverFile(stateDir));
  if (existsSync(portFile(stateDir))) unlinkSync(portFile(stateDir));
}

/**
 * Cleans up the PID/DRIVER files this invocation just wrote (they describe
 * a dead/foreign gateway now, not a usable one) and exits with a message
 * distinguishing the two foreign-adoption outcomes (openlock-k5j2). Never
 * returns. Extracted out of `startGateway` to keep its cognitive complexity
 * in bounds — see `classifyReadinessOutcome`'s docs for why each outcome is
 * unambiguous evidence, unlike the warn-only already-running-branch check
 * above.
 */
function refuseForeignGatewayAdoption(
  outcome: "foreign-dead-child" | "foreign-lsof-mismatch",
  gwPid: number,
  port: number,
  listeningPids: number[] | null,
  stateDir: string,
): never {
  clearGatewayStateFiles(stateDir);
  const detail =
    outcome === "foreign-dead-child"
      ? `pid ${gwPid} exited (commonly "address already in use")`
      : `pid ${gwPid} is alive but the port's listener is pid(s) ` +
        `${listeningPids?.join(", ") || "(none)"}`;
  console.error(formatForeignGatewayAdoptionError(port, detail));
  if (outcome === "foreign-dead-child") console.error(`Check log: ${logFile(stateDir)}`);
  process.exit(1);
}

// No test-only port-override seam exists for this function on purpose —
// see the file-level comment at the top of ensure-gateway.test.ts for the
// constraint a future live-gateway test must follow instead (thread the
// port as a required parameter of its own; never default to GATEWAY_PORT).
// The state dir IS resolved at call time now (openlock-x8m8, via
// `resolveStateDir()`), which is the ALLOWED seam: a test harness can set
// `OPENLOCK_STATE_DIR` before spawning a child process. What stays forbidden
// is a module-global mutable setter that this production code would read.
export async function startGateway(): Promise<void> {
  const stateDir = resolveStateDir();
  const port = resolveGatewayPort(stateDir);
  const runtime = await resolveRuntime();
  const { running, pid, driver } = gatewayStatus();
  if (running) {
    if (pid !== null) warnIfRecordedGatewayPidMismatch(pid, port);

    const mismatchedDriver = findGatewayDriverMismatch(runtime, driver);
    if (mismatchedDriver !== null) {
      console.error(formatGatewayDriverMismatchError(runtime, mismatchedDriver));
      process.exit(1);
    }
    console.log(`Gateway already running (pid ${pid})`);
    return;
  }

  mkdirSync(stateDir, { recursive: true });

  const [supervisorImage, gatewayBin] = await Promise.all([
    ensureSupervisorImage(),
    getGatewayBinary(),
  ]);
  registerGatewayMetadata(port);

  await ensureSandboxJwtMaterial(gatewayBin, stateDir);

  let podmanSocket: string | undefined;
  if (runtime === "podman") {
    podmanSocket = await resolvePodmanSocket();
  }
  writeGatewayConfigFile(configFile(stateDir), {
    runtime,
    supervisorImage,
    podmanSocket,
    gatewayJwt: {
      signingKeyPath: jwtSigningKey(stateDir),
      publicKeyPath: jwtPublicKey(stateDir),
      kidPath: jwtKid(stateDir),
    },
  });

  const dbPath = join(stateDir, "gateway.db");
  const args = [
    gatewayBin,
    "--config",
    configFile(stateDir),
    "--drivers",
    runtime,
    "--disable-tls",
    "--port",
    String(port),
    "--db-url",
    `sqlite:${dbPath}?mode=rwc`,
    // On Linux, rootless podman containers see `host.containers.internal` as
    // the slirp4netns/pasta gateway IP, not loopback — so the gateway must
    // bind on a non-loopback interface to be reachable. On macOS the podman
    // machine VM bridges container traffic back to the host's 127.0.0.1, so
    // the default bind is fine.
    ...(process.platform === "linux" ? ["--bind-address", "0.0.0.0"] : []),
  ];

  rotateLogIfLarge(logFile(stateDir), GATEWAY_LOG_MAX_BYTES);
  const { pid: gwPid } = spawnDaemonToLog(args, stateDir, logFile(stateDir));

  writeFileSync(pidFile(stateDir), String(gwPid));
  writeFileSync(driverFile(stateDir), runtime);
  // Cache only — see portFile's/findGatewayPortRecordMismatch's doc.
  // `resolveGatewayPort(stateDir)` remains the authority on every path that
  // re-derives it; this is purely so the value is inspectable and so
  // `openlock doctor` can flag a state dir relocated after this write.
  writeFileSync(portFile(stateDir), String(port));
  console.log(`Gateway starting (pid ${gwPid}), log: ${logFile(stateDir)}`);

  await waitForGatewayReady(gwPid, port, stateDir);
}

/**
 * Polls until the just-spawned `gwPid` is confirmed ready, or exits the
 * process on any failure/timeout/foreign-adoption outcome. Never returns
 * except on success. Extracted out of `startGateway` to keep its cognitive
 * complexity in bounds.
 */
async function waitForGatewayReady(gwPid: number, port: number, stateDir: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await Bun.sleep(1000);
    if (!pidAlive(gwPid)) {
      const log = logFile(stateDir);
      const tail = existsSync(log)
        ? readFileSync(log, "utf-8").split("\n").slice(-20).join("\n")
        : "(no log)";
      console.error(`Gateway exited unexpectedly. Last 20 lines:\n${tail}`);
      // openlock-u60k: was missing here — the confirmed-dead-child branch
      // below (refuseForeignGatewayAdoption) already did this cleanup, this
      // one didn't, so the two abort-after-spawn paths disagreed about
      // whether a dead child leaves stale state files behind. See
      // clearGatewayStateFiles's doc for why this branch qualifies (child
      // confirmed dead, unlike the 30s-timeout branch further down).
      clearGatewayStateFiles(stateDir);
      process.exit(1);
    }
    try {
      // NOTE (openlock-k5j2): probing `/` — as opposed to a real health
      // endpoint — is INTENTIONAL and must stay exactly as-is. Verified
      // empirically against the actual running gateway binary this project
      // ships (pinned fork release, `openshell-gateway`): `/`, `/health`,
      // `/healthz`, `/readyz`, `/livez`, and `/v1/health` ALL return 404
      // with an empty body. This port speaks gRPC, not a health-checkable
      // HTTP API, on the binary openlock actually runs. This fetch only
      // needs to prove SOMETHING is bound and answering HTTP at all — a
      // 404 is success. DO NOT "fix" this into a `/health`/`/readyz` check
      // — that would make every `gateway start` time out after 30s on
      // every machine, every time.
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
    } catch {
      continue;
    }

    const outcome = classifyPostFetchOutcome(gwPid, port);
    if (outcome.outcome === "foreign-dead-child" || outcome.outcome === "foreign-lsof-mismatch") {
      refuseForeignGatewayAdoption(outcome.outcome, gwPid, port, outcome.listeningPids, stateDir);
    }

    console.log("Gateway ready.");
    warnIfGatewayLoopbackOnly(port, process.platform);
    return;
  }
  console.error("Gateway did not become ready within 30s.");
  console.error(`Check log: ${logFile(stateDir)}`);
  process.exit(1);
}

/**
 * A responding `/` does NOT by itself prove gwPid served it — re-check
 * gwPid's own liveness AFTER the fetch resolved, not the check from the top
 * of the CALLER's SAME loop iteration: a bind-failure race can kill gwPid
 * in the interval between that earlier check and the fetch settling. See
 * `classifyReadinessOutcome`'s docs for the full reasoning; this re-check
 * is the fix for openlock-k5j2's exhibited bug and needs no external tool,
 * so it is guaranteed to run on every platform, including CI. Extracted out
 * of `waitForGatewayReady` to keep its cognitive complexity in bounds.
 */
function classifyPostFetchOutcome(
  gwPid: number,
  port: number,
): { outcome: ReadinessOutcome; listeningPids: number[] | null } {
  const childAlive = pidAlive(gwPid);
  // lsof strengthening check only when the child is alive — if it's already
  // dead, "foreign-dead-child" fires regardless, so there's nothing to gain
  // from spawning lsof first.
  const listeningPids = childAlive ? getListeningPids(port) : null;
  const outcome = classifyReadinessOutcome({ fetchOk: true, childAlive, gwPid, listeningPids });
  return { outcome, listeningPids };
}

// ============================================================================
// GH #75 / bd openlock-7er piece 2: the loopback fetch above only proves the
// gateway process is up and serving *somewhere* — binding to 0.0.0.0 always
// also answers on 127.0.0.1, so it can't tell "correctly bound wide per our
// own --bind-address 0.0.0.0 flag" apart from "silently fell back to
// loopback-only" (e.g. a fork regression, a config-file override clobbering
// the CLI flag). That distinction matters only on Linux: on macOS we never
// pass --bind-address at all, because the podman machine VM bridges
// container traffic back to the host's 127.0.0.1 itself, so loopback-only
// there is correct, not a bug.
//
// This is deliberately NOT a substitute for piece 1's real container-network
// probe (doctor.ts) — `host.containers.internal`'s target address is
// netns-scoped (created per-network by rootless podman's port forwarding) and
// isn't dialable from the host's own root netns independent of a sandbox
// network existing, which may not be true yet at gateway-start time. This
// only asserts the bind-address configuration itself took effect — necessary
// but not sufficient for true container reachability.
//
// WARN-ONLY by design: this never blocks gateway startup (still declared
// ready on the existing loopback-fetch success above) and stays silent on
// anything short of a clear loopback-only finding — a false alarm here is
// worse than the gap, since it runs on every gateway start.
// ============================================================================

export type ProcNetTcpBindClassification = "wide" | "loopback" | "inconclusive";

const TCP_LISTEN_STATE = "0A";

/** Local bind addresses (uppercase hex, procfs little-endian encoding) of
 * LISTEN-state entries matching `port` in a /proc/net/tcp[6]-shaped table. */
function listenLocalAddrHexes(raw: string, port: number): string[] {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const hexes: string[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // sl local_address rem_address st ... — need at least through `st`.
    if (fields.length < 4) continue;
    const [addrHex, addrPortHex] = (fields[1] ?? "").split(":");
    if (fields[3] !== TCP_LISTEN_STATE || addrPortHex !== portHex || !addrHex) continue;
    hexes.push(addrHex.toUpperCase());
  }
  return hexes;
}

/** Pure: classifies the gateway's LISTEN bind for `port` from raw
 * /proc/net/tcp (+ optional /proc/net/tcp6) content.
 *
 * - "wide": found an IPv4 0.0.0.0 (`00000000`) or IPv6 `::` (all-zero,
 *   dual-stack) wildcard bind — container-reachable, no warning.
 * - "loopback": found IPv4 127.0.0.1 (`0100007F`) and nothing wide anywhere,
 *   and no unrecognized tcp6 entry muddying the water — the one case that
 *   warrants a warning.
 * - "inconclusive": entry absent, unexpected/unrecognized address, or an
 *   ambiguous mix (e.g. IPv4 loopback alongside a tcp6 entry we don't
 *   attempt to decode) — silence beats a false alarm here.
 */
export function classifyProcNetTcpBind(
  procNetTcp: string,
  port: number,
  procNetTcp6 = "",
): ProcNetTcpBindClassification {
  const v4 = listenLocalAddrHexes(procNetTcp, port);
  const v6 = listenLocalAddrHexes(procNetTcp6, port);

  const v4Wildcard = v4.some((h) => h === "00000000");
  const v6Wildcard = v6.some((h) => /^0+$/.test(h));
  if (v4Wildcard || v6Wildcard) return "wide";

  const v4Loopback = v4.some((h) => h === "0100007F");
  // Any tcp6 entry we didn't just rule out as wildcard is unrecognized —
  // don't guess at its reachability, stay silent rather than risk both a
  // false positive and a false negative.
  if (v4Loopback && v6.length === 0) return "loopback";

  return "inconclusive";
}

function readProcFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Linux-only, warn-only. Never throws, never affects gateway readiness. */
export function warnIfGatewayLoopbackOnly(port: number, platform: NodeJS.Platform): void {
  if (platform !== "linux") return;
  const classification = classifyProcNetTcpBind(
    readProcFileSafe("/proc/net/tcp"),
    port,
    readProcFileSafe("/proc/net/tcp6"),
  );
  if (classification !== "loopback") return;
  console.warn(
    `gateway bound to 127.0.0.1 only; Linux sandbox containers can't reach it — ` +
      "expected --bind-address 0.0.0.0 (see GH #75)",
  );
}

export function stopGateway(): void {
  const { running, pid } = gatewayStatus();
  if (!running || pid === null) {
    console.log("Gateway not running.");
    return;
  }
  process.kill(pid, "SIGTERM");
  const stateDir = resolveStateDir();
  clearGatewayStateFiles(stateDir);
  console.log(`Gateway stopped (pid ${pid}).`);
}
