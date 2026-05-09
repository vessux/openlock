import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ImageRef {
  tag: string;
  built: boolean;
}

export interface EnsureImageArgs {
  containerfileContent: string;
  tagPrefix: string;
  noCache?: boolean;
}

export function computeImageTag(content: string, tagPrefix: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `${tagPrefix}:${hash}`;
}

export function contextDirForHash(hash: string): string {
  const home = process.env.HOME || homedir();
  return join(home, ".cache", "openlock", "build-context", hash);
}

async function imageExists(tag: string): Promise<boolean> {
  const proc = Bun.spawn(["podman", "image", "exists", tag], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  return code === 0;
}

export async function ensureImage(args: EnsureImageArgs): Promise<ImageRef> {
  const tag = computeImageTag(args.containerfileContent, args.tagPrefix);
  const hash = tag.split(":")[1];

  if (!args.noCache && (await imageExists(tag))) {
    return { tag, built: false };
  }

  const dir = contextDirForHash(hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Dockerfile"), args.containerfileContent);

  const buildArgs = ["podman", "build", "-t", tag];
  if (args.noCache) buildArgs.push("--no-cache");
  buildArgs.push(dir);

  const proc = Bun.spawn(buildArgs, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`podman build failed (exit ${code}): ${buildArgs.join(" ")}`);
  }
  return { tag, built: true };
}
