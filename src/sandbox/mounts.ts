import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { podmanCpInto, podmanExecChownSandbox, podmanExecRmRf } from "./container";

type MountType = "copy-once" | "copy-refresh" | "bind" | "git-bundle";

export interface Mount {
  source: string;
  target: string;
  type: MountType;
}

const SANDBOX_MOUNT_PREFIX = "/sandbox/.openlock/";

const RESERVED_MOUNT_NAMES: ReadonlySet<string> = new Set(["repo.bundle", ".gitconfig"]);

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function resolveSource(projectRoot: string, raw: string): string {
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
}

function validateTarget(target: string): void {
  if (!isAbsolute(target)) {
    throw new Error(`mount target must be absolute: ${target}`);
  }
  if (target.split("/").includes("..")) {
    throw new Error(`mount target must not contain '..' segments: ${target}`);
  }
  if (!target.startsWith(SANDBOX_MOUNT_PREFIX) || target.length <= SANDBOX_MOUNT_PREFIX.length) {
    throw new Error(`mount target must be under /sandbox/.openlock/: ${target}`);
  }
  const rel = target.slice(SANDBOX_MOUNT_PREFIX.length);
  const topSegment = rel.split("/")[0];
  if (topSegment !== undefined && RESERVED_MOUNT_NAMES.has(topSegment)) {
    throw new Error(
      `mount target conflicts with openlock-internal name '${topSegment}': ${target}`,
    );
  }
}

export function stagingPathFor(target: string): string {
  validateTarget(target);
  return target.slice(SANDBOX_MOUNT_PREFIX.length);
}

interface RawMount {
  source?: unknown;
  target?: unknown;
  type?: unknown;
}

function parseOne(raw: RawMount, projectRoot: string, index: number): Mount {
  const where = `mounts[${index}]`;
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    throw new Error(`${where}: 'source' must be a non-empty string`);
  }
  if (typeof raw.target !== "string" || raw.target.length === 0) {
    throw new Error(`${where}: 'target' must be a non-empty string`);
  }
  if (typeof raw.type !== "string") {
    throw new Error(
      `${where}: 'type' must be one of copy-once, copy-refresh, bind, git-bundle`,
    );
  }
  const type = raw.type;
  if (type !== "copy-once" && type !== "copy-refresh" && type !== "bind" && type !== "git-bundle") {
    throw new Error(
      `${where}: unknown type '${type}' (allowed: copy-once, copy-refresh, bind, git-bundle)`,
    );
  }
  validateTarget(raw.target);
  const source = resolveSource(projectRoot, raw.source);
  if (!existsSync(source)) {
    throw new Error(`${where}: source ${source} does not exist`);
  }
  const isDir = statSync(source).isDirectory();
  if ((type === "copy-once" || type === "copy-refresh" || type === "git-bundle") && !isDir) {
    throw new Error(`${where}: source ${source} is not a directory`);
  }
  return { source, target: raw.target, type };
}

export function parseMounts(raw: unknown, projectRoot: string): Mount[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("'mounts' must be a list");
  }
  const out: Mount[] = [];
  const targets = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const m = parseOne(raw[i] as RawMount, projectRoot, i);
    if (targets.has(m.target)) {
      throw new Error(`mounts[${i}]: duplicate target ${m.target}`);
    }
    targets.add(m.target);
    out.push(m);
  }
  return out;
}

export function stageMounts(stagingDir: string, mounts: readonly Mount[]): void {
  for (const m of mounts) {
    const rel = stagingPathFor(m.target);
    const dest = join(stagingDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(m.source, dest, { recursive: true, dereference: true });
  }
}

export async function restageMount(containerName: string, mount: Mount): Promise<void> {
  const targetParent = dirname(mount.target);
  const targetLeaf = basename(mount.target);
  const tmp = mkdtempSync(join(tmpdir(), "openlock-restage-"));
  try {
    const localCopy = join(tmp, targetLeaf);
    cpSync(mount.source, localCopy, { recursive: true, dereference: true });
    await podmanExecRmRf(containerName, mount.target);
    await podmanCpInto(localCopy, containerName, `${targetParent}/`);
    await podmanExecChownSandbox(containerName, mount.target);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
