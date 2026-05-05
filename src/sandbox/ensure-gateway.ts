import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { homedir } from "os";
import { ensureSupervisorImage } from "./build-supervisor-image";
import { getGatewayBinary } from "./fork-binaries";

const STATE_DIR = join(homedir(), ".local", "state", "openlock");
const PID_FILE = join(STATE_DIR, "gateway.pid");
const LOG_FILE = join(STATE_DIR, "gateway.log");
const HANDSHAKE_SECRET_FILE = join(STATE_DIR, "handshake-secret");
const GATEWAY_PORT = 18081;
const GATEWAY_NAME = "podman-dev";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

export function gatewayStatus(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (pid === null) return { running: false, pid: null };
  if (isProcessAlive(pid)) return { running: true, pid };
  unlinkSync(PID_FILE);
  return { running: false, pid: null };
}


function registerGatewayMetadata(): void {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
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

function getHandshakeSecret(): string {
  if (existsSync(HANDSHAKE_SECRET_FILE)) {
    const secret = readFileSync(HANDSHAKE_SECRET_FILE, "utf-8").trim();
    if (secret.length > 0) return secret;
  }
  const secret = randomBytes(32).toString("hex");
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(HANDSHAKE_SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

async function resolvePodmanSocket(): Promise<string> {
  // macOS routes podman through a VM; the host-visible socket only exists in
  // `podman machine inspect`. On Linux podman runs directly on the host, so
  // `podman info` returns the real socket path.
  if (process.platform === "linux") {
    const proc = Bun.spawn(
      ["podman", "info", "--format", "{{.Host.RemoteSocket.Path}}"],
      { stdout: "pipe", stderr: "pipe" },
    );
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

export async function startGateway(): Promise<void> {
  const { running, pid } = gatewayStatus();
  if (running) {
    console.log(`Gateway already running (pid ${pid})`);
    return;
  }

  mkdirSync(STATE_DIR, { recursive: true });

  const supervisorImage = await ensureSupervisorImage();
  const gatewayBin = await getGatewayBinary();
  registerGatewayMetadata();

  const podmanSocket = await resolvePodmanSocket();
  const handshakeSecret = getHandshakeSecret();

  const dbPath = join(STATE_DIR, "gateway.db");
  const args = [
    gatewayBin,
    "--drivers", "podman",
    "--disable-tls",
    "--port", String(GATEWAY_PORT),
    "--db-url", `sqlite:${dbPath}?mode=rwc`,
    "--sandbox-namespace", "podman-dev",
    "--sandbox-image", "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    "--grpc-endpoint", `http://host.containers.internal:${GATEWAY_PORT}`,
    "--ssh-handshake-secret", handshakeSecret,
  ];

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    OPENSHELL_PODMAN_SOCKET: podmanSocket,
    OPENSHELL_SUPERVISOR_IMAGE: supervisorImage,
  };

  const proc = Bun.spawn(["bash", "-c", `exec ${args.map(a => `'${a}'`).join(" ")} >> "${LOG_FILE}" 2>&1`], {
    cwd: STATE_DIR,
    stdout: "ignore",
    stderr: "ignore",
    env,
  });

  writeFileSync(PID_FILE, String(proc.pid));
  console.log(`Gateway starting (pid ${proc.pid}), log: ${LOG_FILE}`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await Bun.sleep(1000);
    if (!isProcessAlive(proc.pid)) {
      const tail = existsSync(LOG_FILE)
        ? readFileSync(LOG_FILE, "utf-8").split("\n").slice(-20).join("\n")
        : "(no log)";
      console.error(`Gateway exited unexpectedly. Last 20 lines:\n${tail}`);
      process.exit(1);
    }
    try {
      await fetch(`http://localhost:${GATEWAY_PORT}/`, { signal: AbortSignal.timeout(1000) });
      console.log("Gateway ready.");
      return;
    } catch {}
  }
  console.error("Gateway did not become ready within 30s.");
  console.error(`Check log: ${LOG_FILE}`);
  process.exit(1);
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
