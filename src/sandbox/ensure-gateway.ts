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
import { join } from "node:path";
import { type Runtime, resolveRuntime } from "../runtime";
import { ensureSupervisorImage } from "./build-supervisor-image";
import { getGatewayBinary } from "./fork-binaries";
import { pidAlive } from "./proc";

const STATE_DIR = join(process.env.HOME || homedir(), ".local", "state", "openlock");
const PID_FILE = join(STATE_DIR, "gateway.pid");
const LOG_FILE = join(STATE_DIR, "gateway.log");
// gateway.log is appended to forever across gateway restarts (openlock-lai:
// observed at 100MB, unrotated). Rotate at (re)start time — the only moment
// openlock touches the file — keeping exactly one backup generation.
const GATEWAY_LOG_MAX_BYTES = 10 * 1024 * 1024;
const CONFIG_FILE = join(STATE_DIR, "gateway-config.toml");
// Sandbox-JWT signing material. Since upstream #1404 the sandbox supervisor
// requires a gateway-minted JWT to fetch its policy — without one it exits
// during provisioning. The gateway mints per-sandbox tokens only when this
// bundle is present, so we generate it once and point the gateway at it.
const PKI_DIR = join(STATE_DIR, "pki");
const JWT_SIGNING_KEY = join(PKI_DIR, "jwt", "signing.pem");
const JWT_PUBLIC_KEY = join(PKI_DIR, "jwt", "public.pem");
const JWT_KID = join(PKI_DIR, "jwt", "kid");
export const GATEWAY_PORT = 18081;
// Historical name from the podman-only era; now drives podman OR docker per
// `--drivers` resolution. Kept stable so existing on-disk state under
// `~/.config/openshell/gateways/podman-dev/` stays valid. Revisit at v1.0.
export const GATEWAY_NAME = "podman-dev";

const DEFAULT_SANDBOX_IMAGE = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest";

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
  rssKb?: number;
  uptimeMs?: number;
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

export function gatewayStatus(): GatewayStatus {
  const pid = readPid();
  if (pid === null) return { running: false, pid: null };
  if (!pidAlive(pid)) {
    unlinkSync(PID_FILE);
    return { running: false, pid: null };
  }
  const rssKb = readGatewayRssKb(pid) ?? undefined;
  let uptimeMs: number | undefined;
  try {
    const stat = statSync(PID_FILE);
    uptimeMs = Date.now() - stat.mtimeMs;
  } catch {
    uptimeMs = undefined;
  }
  return { running: true, pid, rssKb, uptimeMs };
}

function registerGatewayMetadata(): void {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME || homedir(), ".config");
  const gatewayDir = join(configHome, "openshell", "gateways", GATEWAY_NAME);
  mkdirSync(gatewayDir, { recursive: true });

  writeFileSync(
    join(gatewayDir, "metadata.json"),
    JSON.stringify({
      name: GATEWAY_NAME,
      gateway_endpoint: `http://127.0.0.1:${GATEWAY_PORT}`,
      is_remote: false,
      gateway_port: GATEWAY_PORT,
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

function writeGatewayConfigFile(opts: {
  runtime: Runtime;
  supervisorImage: string;
  podmanSocket?: string;
  gatewayJwt?: { signingKeyPath: string; publicKeyPath: string; kidPath: string };
}): void {
  writeFileSync(CONFIG_FILE, renderGatewayConfigToml(opts.runtime, opts));
}

// Generate the sandbox-JWT signing bundle if absent. Idempotent: the gateway's
// `generate-certs` skips when the files already exist. Also emits an (unused)
// TLS bundle alongside the JWT material, which is harmless under --disable-tls.
async function ensureSandboxJwtMaterial(gatewayBin: string): Promise<void> {
  if (existsSync(JWT_SIGNING_KEY) && existsSync(JWT_PUBLIC_KEY) && existsSync(JWT_KID)) {
    return;
  }
  const proc = Bun.spawn([gatewayBin, "generate-certs", "--output-dir", PKI_DIR], {
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

export async function startGateway(): Promise<void> {
  const runtime = await resolveRuntime();
  const { running, pid } = gatewayStatus();
  if (running) {
    console.log(`Gateway already running (pid ${pid})`);
    return;
  }

  mkdirSync(STATE_DIR, { recursive: true });

  const [supervisorImage, gatewayBin] = await Promise.all([
    ensureSupervisorImage(),
    getGatewayBinary(),
  ]);
  registerGatewayMetadata();

  await ensureSandboxJwtMaterial(gatewayBin);

  let podmanSocket: string | undefined;
  if (runtime === "podman") {
    podmanSocket = await resolvePodmanSocket();
  }
  writeGatewayConfigFile({
    runtime,
    supervisorImage,
    podmanSocket,
    gatewayJwt: {
      signingKeyPath: JWT_SIGNING_KEY,
      publicKeyPath: JWT_PUBLIC_KEY,
      kidPath: JWT_KID,
    },
  });

  const dbPath = join(STATE_DIR, "gateway.db");
  const args = [
    gatewayBin,
    "--config",
    CONFIG_FILE,
    "--drivers",
    runtime,
    "--disable-tls",
    "--port",
    String(GATEWAY_PORT),
    "--db-url",
    `sqlite:${dbPath}?mode=rwc`,
    // On Linux, rootless podman containers see `host.containers.internal` as
    // the slirp4netns/pasta gateway IP, not loopback — so the gateway must
    // bind on a non-loopback interface to be reachable. On macOS the podman
    // machine VM bridges container traffic back to the host's 127.0.0.1, so
    // the default bind is fine.
    ...(process.platform === "linux" ? ["--bind-address", "0.0.0.0"] : []),
  ];

  rotateLogIfLarge(LOG_FILE, GATEWAY_LOG_MAX_BYTES);
  const { pid: gwPid } = spawnDaemonToLog(args, STATE_DIR, LOG_FILE);

  writeFileSync(PID_FILE, String(gwPid));
  console.log(`Gateway starting (pid ${gwPid}), log: ${LOG_FILE}`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await Bun.sleep(1000);
    if (!pidAlive(gwPid)) {
      const tail = existsSync(LOG_FILE)
        ? readFileSync(LOG_FILE, "utf-8").split("\n").slice(-20).join("\n")
        : "(no log)";
      console.error(`Gateway exited unexpectedly. Last 20 lines:\n${tail}`);
      process.exit(1);
    }
    try {
      await fetch(`http://localhost:${GATEWAY_PORT}/`, { signal: AbortSignal.timeout(1000) });
      console.log("Gateway ready.");
      warnIfGatewayLoopbackOnly(GATEWAY_PORT, process.platform);
      return;
    } catch {}
  }
  console.error("Gateway did not become ready within 30s.");
  console.error(`Check log: ${LOG_FILE}`);
  process.exit(1);
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
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  console.log(`Gateway stopped (pid ${pid}).`);
}
