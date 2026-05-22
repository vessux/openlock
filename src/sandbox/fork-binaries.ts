import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forkDir } from "../paths";

// Pinned openshell fork release. Bump this constant when a new fork
// release ships, alongside any matching changes in openlock that depend
// on fork-side behavior.
const OPENSHELL_FORK_REPO = "vessux/OpenShell";
export const OPENSHELL_FORK_TAG = "v0.4.0";

type ForkBinary = "openshell-gateway" | "openshell-sandbox" | "openshell";

const CACHE_DIR = join(
  process.env.HOME || homedir(),
  ".cache",
  "openlock",
  "bin",
  OPENSHELL_FORK_TAG,
);

export function isDevMode(): boolean {
  return existsSync(join(forkDir(), ".git"));
}

function rustTriple(name: ForkBinary): string {
  // openshell-sandbox always runs in a Linux container — its triple is
  // determined by the *container* arch (matches host on Linux, matches
  // podman machine on macOS, which on Apple Silicon is aarch64).
  // For the other two binaries it's the host triple.
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (name === "openshell-sandbox") {
    return `${arch}-unknown-linux-gnu`;
  }
  if (process.platform === "darwin") {
    return `${arch}-apple-darwin`;
  }
  return `${arch}-unknown-linux-gnu`;
}

function downloadUrl(name: ForkBinary): string {
  const triple = rustTriple(name);
  return `https://github.com/${OPENSHELL_FORK_REPO}/releases/download/${OPENSHELL_FORK_TAG}/${name}-${triple}.tar.gz`;
}

async function ensureFromRelease(name: ForkBinary): Promise<string> {
  const triple = rustTriple(name);
  const cached = join(CACHE_DIR, `${name}-${triple}`);
  if (existsSync(cached)) return cached;

  mkdirSync(CACHE_DIR, { recursive: true });
  const url = downloadUrl(name);
  console.log(`Fetching ${name} from ${url}`);
  const tmpTar = `${cached}.tar.gz`;
  const curl = Bun.spawn(["curl", "-fsSL", "-o", tmpTar, url], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await curl.exited) !== 0) {
    throw new Error(`Failed to download ${url}`);
  }
  const tar = Bun.spawn(["tar", "-xzf", tmpTar, "-C", CACHE_DIR], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await tar.exited) !== 0) {
    throw new Error(`Failed to extract ${tmpTar}`);
  }
  const extracted = join(CACHE_DIR, name);
  if (!existsSync(extracted)) {
    throw new Error(`Tarball did not contain expected binary: ${name}`);
  }
  renameSync(extracted, cached);
  chmodSync(cached, 0o755);
  Bun.spawn(["rm", "-f", tmpTar]);
  return cached;
}

async function buildFromSource(
  crate: string,
  target?: string,
  useZigbuild = false,
): Promise<string> {
  const fork = forkDir();
  const argv = useZigbuild
    ? ["cargo", "zigbuild", "-p", crate, "--target", target!, "--release"]
    : target
      ? ["cargo", "build", "-p", crate, "--target", target, "--release"]
      : ["cargo", "build", "-p", crate, "--release"];
  console.log(`Building ${crate}${target ? ` (${target})` : ""}...`);
  const proc = Bun.spawn(argv, { cwd: fork, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    throw new Error(`cargo build failed for ${crate}`);
  }
  const binName = crate === "openshell-server" ? "openshell-gateway" : crate;
  const releasePath = target
    ? join(fork, "target", target, "release", binName)
    : join(fork, "target", "release", binName);
  return releasePath;
}

export async function getGatewayBinary(): Promise<string> {
  if (isDevMode()) {
    return await buildFromSource("openshell-server");
  }
  return await ensureFromRelease("openshell-gateway");
}

export async function getSupervisorBinary(): Promise<string> {
  if (isDevMode()) {
    if (process.platform === "linux") {
      return await buildFromSource("openshell-sandbox");
    }
    const target =
      process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    return await buildFromSource("openshell-sandbox", target, true);
  }
  return await ensureFromRelease("openshell-sandbox");
}

// CLI is invoked via `mise exec` in dev mode (mise resolves the locally
// installed openshell tool); in prod mode we exec the downloaded binary
// directly. Returning the argv prefix + cwd lets call sites stay uniform.
export interface CliInvocation {
  argv: string[];
  cwd: string | undefined;
}

export async function getCliInvocation(): Promise<CliInvocation> {
  if (isDevMode()) {
    return { argv: ["mise", "exec", "--", "openshell"], cwd: forkDir() };
  }
  const bin = await ensureFromRelease("openshell");
  return { argv: [bin], cwd: undefined };
}
