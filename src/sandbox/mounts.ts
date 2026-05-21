import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { podmanCpInto, podmanExecChownSandbox, podmanExecRmRf } from "./container";

type MountType = "copy-once" | "copy-refresh" | "bind" | "git-bundle";

export interface Mount {
  source: string;
  target: string;
  type: MountType;
  readOnly?: boolean;
}

const SANDBOX_OPENLOCK_PREFIX = "/sandbox/.openlock/";

const RESERVED_MOUNT_NAMES: ReadonlySet<string> = new Set(["repo.bundle", ".gitconfig", "bundles"]);

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function resolveSource(projectRoot: string, raw: string): string {
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
}

function commonTargetChecks(target: string, where: string): void {
  if (!isAbsolute(target)) {
    throw new Error(`${where}: mount target must be absolute: ${target}`);
  }
  if (target.split("/").includes("..")) {
    throw new Error(`${where}: mount target must not contain '..' segments: ${target}`);
  }
  if (target.startsWith(SANDBOX_OPENLOCK_PREFIX)) {
    const rel = target.slice(SANDBOX_OPENLOCK_PREFIX.length);
    const topSegment = rel.split("/")[0];
    if (topSegment !== undefined && RESERVED_MOUNT_NAMES.has(topSegment)) {
      throw new Error(
        `${where}: mount target conflicts with openlock-internal name '${topSegment}': ${target}`,
      );
    }
  }
}

function validateTargetForType(target: string, type: MountType, where: string): void {
  commonTargetChecks(target, where);
  if (type === "copy-once" || type === "copy-refresh") {
    if (target === "/sandbox/repo") {
      throw new Error(
        `${where}: target /sandbox/repo not supported with type '${type}'; use git-bundle (host repo bundled in) or bind (live host sync), or omit the workdir mount`,
      );
    }
    if (!target.startsWith(SANDBOX_OPENLOCK_PREFIX) || target.length <= SANDBOX_OPENLOCK_PREFIX.length) {
      throw new Error(
        `${where}: mount target must be under /sandbox/.openlock/ for type '${type}': ${target}`,
      );
    }
    return;
  }
  if (type === "git-bundle") {
    if (target.startsWith(SANDBOX_OPENLOCK_PREFIX)) {
      throw new Error(
        `${where}: git-bundle target must not be under /sandbox/.openlock/: ${target}`,
      );
    }
    return;
  }
  // type === "bind": no further restriction
}

function assertGitWorkingTree(source: string, where: string): void {
  const dotGit = join(source, ".git");
  if (!existsSync(dotGit)) {
    throw new Error(`${where}: source ${source} is not a git working tree (missing .git)`);
  }
}

export function stagingPathFor(target: string): string {
  commonTargetChecks(target, "stagingPathFor");
  if (!target.startsWith(SANDBOX_OPENLOCK_PREFIX) || target.length <= SANDBOX_OPENLOCK_PREFIX.length) {
    throw new Error(`stagingPathFor: target must be under /sandbox/.openlock/: ${target}`);
  }
  return target.slice(SANDBOX_OPENLOCK_PREFIX.length);
}

interface RawMount {
  source?: unknown;
  target?: unknown;
  type?: unknown;
  readOnly?: unknown;
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
  let readOnly: boolean | undefined;
  if (raw.readOnly !== undefined) {
    if (typeof raw.readOnly !== "boolean") {
      throw new Error(`${where}: readOnly must be a boolean`);
    }
    if (type !== "bind") {
      throw new Error(`${where}: readOnly is only valid on type: bind`);
    }
    readOnly = raw.readOnly;
  }
  validateTargetForType(raw.target, type, where);
  const source = resolveSource(projectRoot, raw.source);
  if (!existsSync(source)) {
    throw new Error(`${where}: source ${source} does not exist`);
  }
  const isDir = statSync(source).isDirectory();
  if ((type === "copy-once" || type === "copy-refresh" || type === "git-bundle") && !isDir) {
    throw new Error(`${where}: source ${source} is not a directory`);
  }
  if (type === "git-bundle") {
    assertGitWorkingTree(source, where);
  }
  return readOnly !== undefined
    ? { source, target: raw.target, type, readOnly }
    : { source, target: raw.target, type };
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

export function workdirMount(mounts: readonly Mount[]): Mount | undefined {
  return mounts.find((m) => m.target === "/sandbox/repo");
}
