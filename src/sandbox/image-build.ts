import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Runtime, resolveRuntime } from "../runtime";

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

export function buildImageExistsArgv(runtime: Runtime, tag: string): string[] {
  return runtime === "podman"
    ? ["podman", "image", "exists", tag]
    : ["docker", "image", "inspect", tag];
}

export function buildImageBuildArgv(
  runtime: Runtime,
  tag: string,
  contextDir: string,
  noCache?: boolean,
): string[] {
  const argv = [runtime, "build", "-t", tag];
  if (noCache) argv.push("--no-cache");
  argv.push(contextDir);
  return argv;
}

async function imageExists(runtime: Runtime, tag: string): Promise<boolean> {
  const proc = Bun.spawn(buildImageExistsArgv(runtime, tag), {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function ensureImage(args: EnsureImageArgs): Promise<ImageRef> {
  const runtime = await resolveRuntime();
  const tag = computeImageTag(args.containerfileContent, args.tagPrefix);
  const hash = tag.split(":")[1];

  if (!args.noCache && (await imageExists(runtime, tag))) {
    return { tag, built: false };
  }

  const dir = contextDirForHash(hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Dockerfile"), args.containerfileContent);

  const buildArgs = buildImageBuildArgv(runtime, tag, dir, args.noCache);
  const proc = Bun.spawn(buildArgs, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${runtime} build failed (exit ${code}): ${buildArgs.join(" ")}`);
  }
  return { tag, built: true };
}
