import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Embedded at build time via Bun's `with { type: "text" }` import attribute.
import BASE_CONTAINERFILE from "../../containers/base.Containerfile" with { type: "text" };
import { type Runtime, resolveRuntime } from "../runtime";
import { ensureBase as defaultEnsureBase, isOpenlockBaseRef, parseFromImage } from "./ensure-base";

export { BASE_CONTAINERFILE };

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

export interface EnsureSandboxDeps {
  ensureBase: (baseContent: string) => Promise<string>;
  imageExists: (runtime: Runtime, tag: string) => Promise<boolean>;
  build: (runtime: Runtime, tag: string, contextDir: string) => Promise<void>;
}

export async function ensureSandbox(
  userContainerfileContent: string,
  deps?: Partial<EnsureSandboxDeps>,
): Promise<string> {
  const runtime = await resolveRuntime();
  const d = {
    ensureBase: deps?.ensureBase ?? ((c: string) => defaultEnsureBase(c)),
    imageExists: deps?.imageExists ?? defaultImageExistsInternal,
    build: deps?.build ?? defaultBuildInternal,
  };

  const fromImage = parseFromImage(userContainerfileContent);
  if (isOpenlockBaseRef(fromImage)) {
    await d.ensureBase(BASE_CONTAINERFILE);
  }
  // else: third-party FROM — let podman/docker handle the pull during build.

  const userTag = computeImageTag(userContainerfileContent, "openlock-sandbox");
  if (await d.imageExists(runtime, userTag)) return userTag;

  const hash = userTag.split(":")[1];
  const ctx = contextDirForHash(hash);
  mkdirSync(ctx, { recursive: true });
  writeFileSync(join(ctx, "Dockerfile"), userContainerfileContent);
  await d.build(runtime, userTag, ctx);
  return userTag;
}

async function defaultImageExistsInternal(runtime: Runtime, tag: string): Promise<boolean> {
  const proc = Bun.spawn(buildImageExistsArgv(runtime, tag), {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

async function defaultBuildInternal(
  runtime: Runtime,
  tag: string,
  contextDir: string,
): Promise<void> {
  const argv = buildImageBuildArgv(runtime, tag, contextDir, false);
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${runtime} build failed (exit ${code})`);
}
