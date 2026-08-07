import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Embedded at build time via Bun's `with { type: "text" }` import attribute.
import BASE_CONTAINERFILE from "../../containers/base.Containerfile" with { type: "text" };
import { withLock } from "../lock";
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
  pull?: boolean,
): string[] {
  const argv = [runtime, "build", "-t", tag];
  if (noCache) argv.push("--no-cache");
  // `--no-cache` alone still reuses a locally-cached FROM base; `--pull` forces
  // a re-pull so a mutable third-party tag (e.g. `FROM node:20`) refreshes.
  if (pull) argv.push("--pull");
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

  // Fast, unlocked path: the overwhelmingly common call is "already built" —
  // skip ever touching the lock file for it. `noCache` intentionally forces
  // a rebuild, so this check (and its locked re-check below) are both
  // skipped when set, matching the pre-lock behavior.
  if (!args.noCache && (await imageExists(runtime, tag))) {
    return { tag, built: false };
  }

  const dir = contextDirForHash(hash);
  // openlock-jyk: from here on, the exists re-check AND the build run under
  // a cross-process lock keyed by the image hash, so two concurrent callers
  // building identical Containerfile content serialize onto one real build
  // instead of each independently re-downloading Node/uv. The re-check
  // re-runs INSIDE the lock (not just trusted from the unlocked check above)
  // because another contender may have finished its own build in the time
  // it took us to acquire the lock.
  //
  // NOTE for the next reader: `ensureImage` itself has NO production
  // caller — the real `openlock sandbox` path is session.ts ->
  // `ensureSandbox` below, which has (and now locks) its own equivalent
  // check-then-build sites. `ensureImage` is exercised by
  // tests/integration/*.test.ts, several of which call it with identical
  // (containerfileContent, tagPrefix) — real contention under parallel test
  // workers — which is why it's still worth locking, just not the site the
  // original bug report's "openlock sandbox" framing describes.
  //
  // Deliberately does NOT cache or serialize on FAILURE: if the closure
  // below throws (this call's build failed), the lock is released and the
  // rejection surfaces to THIS caller only — a later, independent
  // `ensureImage` call that was waiting re-runs this same check-then-build
  // itself once it acquires the lock, so it can still rescue an earlier
  // failure (the accidental resilience openlock-jp2 documented and this
  // change must not regress).
  return withLock(`${dir}.lock`, async () => {
    if (!args.noCache && (await imageExists(runtime, tag))) {
      return { tag, built: false };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), args.containerfileContent);

    const buildArgs = buildImageBuildArgv(runtime, tag, dir, args.noCache);
    const proc = Bun.spawn(buildArgs, { stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`${runtime} build failed (exit ${code}): ${buildArgs.join(" ")}`);
    }
    return { tag, built: true };
  });
}

export interface EnsureSandboxDeps {
  ensureBase: (baseContent: string) => Promise<string>;
  imageExists: (runtime: Runtime, tag: string) => Promise<boolean>;
  build: (
    runtime: Runtime,
    tag: string,
    contextDir: string,
    buildOpts?: { noCache?: boolean; pull?: boolean },
  ) => Promise<void>;
}

export async function ensureSandbox(
  userContainerfileContent: string,
  opts?: { rebuild?: boolean },
  deps?: Partial<EnsureSandboxDeps>,
): Promise<string> {
  const runtime = await resolveRuntime();
  const rebuild = opts?.rebuild ?? false;
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
  // --rebuild forces a fresh build (bypass the cached-image short-circuit) with
  // --no-cache + --pull, so a Containerfile pinned to a mutable third-party tag
  // (unchanged text ⇒ identical hash) can be refreshed without manual podman rm.
  if (!rebuild && (await d.imageExists(runtime, userTag))) return userTag;

  const hash = userTag.split(":")[1];
  const ctx = contextDirForHash(hash);
  // openlock-jyk: this is the actual `openlock sandbox` production hot
  // path — two concurrent invocations building the identical user
  // Containerfile now serialize onto one real build. `rebuild` still
  // bypasses the short-circuit exactly as it does above (mirrors `noCache`
  // in `ensureImage`), so the locked re-check is skipped when set too.
  return withLock(`${ctx}.lock`, async () => {
    if (!rebuild && (await d.imageExists(runtime, userTag))) return userTag;
    mkdirSync(ctx, { recursive: true });
    writeFileSync(join(ctx, "Dockerfile"), userContainerfileContent);
    await d.build(runtime, userTag, ctx, { noCache: rebuild, pull: rebuild });
    return userTag;
  });
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
  buildOpts?: { noCache?: boolean; pull?: boolean },
): Promise<void> {
  const argv = buildImageBuildArgv(runtime, tag, contextDir, buildOpts?.noCache, buildOpts?.pull);
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${runtime} build failed (exit ${code})`);
}
