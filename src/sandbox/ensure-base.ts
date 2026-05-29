import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Runtime, resolveRuntime } from "../runtime";

// Inlined here (not imported from image-build) to avoid a circular import,
// since image-build.ts imports from ensure-base.ts.
function contextDirForHash(hash: string): string {
  const home = process.env.HOME || homedir();
  return join(home, ".cache", "openlock", "build-context", hash);
}

export const GHCR_BASE_PREFIX = "ghcr.io/vessux/openlock-base:";

export function computeBaseTag(content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `${GHCR_BASE_PREFIX}${hash}`;
}

export function parseFromImage(containerfile: string): string {
  for (const rawLine of containerfile.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("FROM ")) {
      const after = line.slice(5).trim();
      const asIdx = after.toUpperCase().indexOf(" AS ");
      return asIdx >= 0 ? after.slice(0, asIdx).trim() : after;
    }
  }
  throw new Error("parseFromImage: no active FROM line found");
}

export function isOpenlockBaseRef(ref: string): boolean {
  return ref.startsWith(GHCR_BASE_PREFIX);
}

export interface EnsureBaseDeps {
  imageExists: (runtime: Runtime, tag: string) => Promise<boolean>;
  tryPull: (runtime: Runtime, tag: string) => Promise<boolean>;
  build: (runtime: Runtime, tag: string, contextDir: string) => Promise<void>;
}

export async function ensureBase(
  baseContent: string,
  deps?: Partial<EnsureBaseDeps>,
): Promise<string> {
  const runtime = await resolveRuntime();
  const tag = computeBaseTag(baseContent);
  const d = {
    imageExists: deps?.imageExists ?? defaultImageExists,
    tryPull: deps?.tryPull ?? defaultTryPull,
    build: deps?.build ?? defaultBuild,
  };

  if (await d.imageExists(runtime, tag)) return tag;
  if (await d.tryPull(runtime, tag)) return tag;

  const hash = tag.slice(GHCR_BASE_PREFIX.length);
  const ctx = contextDirForHash(hash);
  mkdirSync(ctx, { recursive: true });
  writeFileSync(join(ctx, "Dockerfile"), baseContent);
  await d.build(runtime, tag, ctx);
  return tag;
}

async function defaultImageExists(runtime: Runtime, tag: string): Promise<boolean> {
  const argv =
    runtime === "podman" ? ["podman", "image", "exists", tag] : ["docker", "image", "inspect", tag];
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function defaultTryPull(runtime: Runtime, tag: string): Promise<boolean> {
  const proc = Bun.spawn([runtime, "pull", tag], { stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) === 0;
}

async function defaultBuild(runtime: Runtime, tag: string, contextDir: string): Promise<void> {
  const proc = Bun.spawn([runtime, "build", "-t", tag, contextDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${runtime} build failed for ${tag} (exit ${code})`);
  }
}
