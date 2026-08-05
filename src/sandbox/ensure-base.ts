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

export type BaseImageDriftStatus =
  | { kind: "match" }
  | { kind: "drift"; pinnedHash: string; expectedHash: string }
  | { kind: "custom" }
  | { kind: "unparseable" };

/**
 * Compare a project's `.openlock/Containerfile` pinned base-image hash
 * against the hash the CLI's currently embedded base-image content would
 * produce (openlock-x83q). `computeBaseTag` is content-addressed, but
 * `renderSeedContainerfile`/`seedContainerfile` bake the resulting tag in as
 * a LITERAL `FROM ghcr.io/vessux/openlock-base:<hash>` line at `openlock
 * init` time — a project's Containerfile never re-derives it, so a base
 * image change (e.g. PR #133's nftables fix) leaves every pre-existing
 * project silently pinned to the stale, still-resolvable old tag. Pure
 * string comparison — no registry or podman call — so it's cheap enough for
 * both `openlock doctor` and the `openlock sandbox` preflight hot path.
 *
 * `currentBaseContent` is passed in rather than imported here to avoid the
 * circular import `image-build.ts` already routes around (see the module
 * comment above) — callers pass `BASE_CONTAINERFILE` from `./image-build`.
 *
 * `"custom"`: the active FROM line isn't an openlock-base reference at all —
 * the documented "comment out FROM+ARGs, uncomment the inline reference
 * block" customization path from `seedContainerfile`. That's a deliberate,
 * legitimate divergence, not drift; reporting it as drift would be a false
 * positive.
 *
 * `"unparseable"`: no active FROM line could be found at all (e.g.
 * hand-edited into something `parseFromImage` doesn't recognize). Treated as
 * "can't compare" just like `"custom"` — never a false positive — but kept
 * as its own variant so callers can tell the two apart if they ever need to.
 */
export function detectBaseImageDrift(
  containerfileContent: string,
  currentBaseContent: string,
): BaseImageDriftStatus {
  let fromRef: string;
  try {
    fromRef = parseFromImage(containerfileContent);
  } catch {
    return { kind: "unparseable" };
  }
  if (!isOpenlockBaseRef(fromRef)) return { kind: "custom" };
  const pinnedHash = fromRef.slice(GHCR_BASE_PREFIX.length);
  const expectedHash = computeBaseTag(currentBaseContent).slice(GHCR_BASE_PREFIX.length);
  if (pinnedHash === expectedHash) return { kind: "match" };
  return { kind: "drift", pinnedHash, expectedHash };
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

  // openlock-6qfr: `tryPull` inherits the runtime's raw stderr (podman's
  // "Error: unable to copy from source docker://... manifest unknown" or
  // similar), which reads like a hard failure with nothing around it saying
  // what happens next — that ambiguity misled a real diagnosis. A failed
  // pull here is EXPECTED whenever this exact content hash hasn't been
  // published to ghcr yet (e.g. a base.Containerfile change landed on main
  // but no release has been tagged since — see
  // .github/workflows/base-image.yml's header) and is always NON-FATAL: the
  // local build below is the intended fallback, not an error path. Placed
  // here rather than inside `defaultTryPull` so it also fires for injected
  // test/deps callers and stays next to the branch it explains.
  console.warn(
    `Registry pull of ${tag} failed (see above) — expected and non-fatal ` +
      "when this exact base hasn't been published yet. Building it locally " +
      "instead (first build is slow: apt + node + uv install).",
  );

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
