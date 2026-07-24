import type { Runtime } from "../runtime";
import { GHCR_BASE_PREFIX } from "./ensure-base";

export interface CategorizeOpts {
  legacy: boolean;
  currentBaseTag: string;
  referencedSandboxTags: Set<string>;
}

export interface CategorizeResult {
  toRemove: string[];
}

const LEGACY_PREFIXES = [
  "openlock-core:",
  "openlock-core-js:",
  "openlock-core-py:",
  "openlock-core-js-py:",
];

export function categorizeImages(allTags: string[], opts: CategorizeOpts): CategorizeResult {
  const toRemove: string[] = [];
  for (const tag of allTags) {
    if (opts.legacy) {
      if (LEGACY_PREFIXES.some((p) => tag.startsWith(p))) toRemove.push(tag);
      continue;
    }
    if (tag.startsWith("openlock-sandbox:") && !opts.referencedSandboxTags.has(tag)) {
      toRemove.push(tag);
    } else if (tag.startsWith(GHCR_BASE_PREFIX) && tag !== opts.currentBaseTag) {
      toRemove.push(tag);
    }
  }
  return { toRemove };
}

export interface PruneDeps {
  listTags: (runtime: Runtime) => Promise<string[]>;
  /** Resolves true when the image was actually removed, false when `image rm`
   * failed (e.g. the image is still referenced by a stopped container). */
  remove: (runtime: Runtime, tag: string) => Promise<boolean>;
  listActiveSandboxTags: () => Promise<Set<string>>;
}

export async function pruneImages(
  opts: { runtime: Runtime; legacy: boolean; currentBaseTag: string; dryRun: boolean },
  deps: PruneDeps,
): Promise<{ removed: string[]; failed: string[] }> {
  const { runtime } = opts;
  const allTags = await deps.listTags(runtime);
  const referenced = await deps.listActiveSandboxTags();
  const { toRemove } = categorizeImages(allTags, {
    legacy: opts.legacy,
    currentBaseTag: opts.currentBaseTag,
    referencedSandboxTags: referenced,
  });
  if (opts.dryRun) return { removed: toRemove, failed: [] };
  // Report only images actually removed — `image rm` fails (non-zero) when a tag
  // is still referenced by a stopped container, and reporting it as removed
  // would give false "reclaimed disk" confidence.
  const removed: string[] = [];
  const failed: string[] = [];
  for (const tag of toRemove) {
    if (await deps.remove(runtime, tag)) removed.push(tag);
    else failed.push(tag);
  }
  return { removed, failed };
}

export async function defaultListTags(runtime: Runtime): Promise<string[]> {
  const proc = Bun.spawn([runtime, "image", "list", "--format", "{{.Repository}}:{{.Tag}}"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith(":<none>"));
}

export async function defaultRemove(runtime: Runtime, tag: string): Promise<boolean> {
  const proc = Bun.spawn([runtime, "image", "rm", tag], {
    stdout: "ignore",
    stderr: "inherit",
  });
  return (await proc.exited) === 0;
}
