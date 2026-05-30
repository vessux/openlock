import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Mount } from "../config-core";
import { SANDBOX_OPENLOCK_PREFIX } from "../config-core";
import { execAsRoot, uploadToSandbox } from "./container";

export type { Mount } from "../config-core";

export function stagingPathFor(target: string): string {
  if (!target.startsWith("/")) {
    throw new Error(`stagingPathFor: mount target must be absolute: ${target}`);
  }
  if (target.split("/").includes("..")) {
    throw new Error(`stagingPathFor: mount target must not contain '..' segments: ${target}`);
  }
  if (
    !target.startsWith(SANDBOX_OPENLOCK_PREFIX) ||
    target.length <= SANDBOX_OPENLOCK_PREFIX.length
  ) {
    throw new Error(`stagingPathFor: target must be under /sandbox/.openlock/: ${target}`);
  }
  return target.slice(SANDBOX_OPENLOCK_PREFIX.length);
}

export function stageMounts(stagingDir: string, mounts: readonly Mount[]): void {
  for (const m of mounts) {
    if (m.type === "bind" || m.type === "git-bundle") continue;
    const rel = stagingPathFor(m.target);
    const dest = join(stagingDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(m.source, dest, { recursive: true, dereference: true });
  }
}

export async function restageMount(containerName: string, mount: Mount): Promise<void> {
  if (mount.type === "bind" || mount.type === "git-bundle") return;
  const targetParent = dirname(mount.target);
  const targetLeaf = basename(mount.target);
  const tmp = mkdtempSync(join(tmpdir(), "openlock-restage-"));
  try {
    const localCopy = join(tmp, targetLeaf);
    cpSync(mount.source, localCopy, { recursive: true, dereference: true });
    await execAsRoot(containerName, ["rm", "-rf", mount.target]);
    await uploadToSandbox(containerName, localCopy, `${targetParent}/`);
    await execAsRoot(containerName, ["chown", "-R", "sandbox:sandbox", mount.target]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function workdirMount(mounts: readonly Mount[]): Mount | undefined {
  return mounts.find((m) => m.target === "/sandbox/repo");
}

export function gitBundleMounts(mounts: readonly Mount[]): Mount[] {
  return mounts.filter((m) => m.type === "git-bundle");
}

export function bindMountArgs(mounts: readonly Mount[]): string[] {
  const args: string[] = [];
  for (const m of mounts) {
    if (m.type !== "bind") continue;
    const spec = m.readOnly ? `${m.source}:${m.target}:ro` : `${m.source}:${m.target}`;
    args.push("--volume", spec);
  }
  return args;
}
