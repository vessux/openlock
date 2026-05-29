import { type Runtime, resolveRuntime } from "../runtime";
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
  remove: (runtime: Runtime, tag: string) => Promise<void>;
  listActiveSandboxTags: () => Promise<Set<string>>;
}

export async function pruneImages(
  opts: { legacy: boolean; currentBaseTag: string; dryRun: boolean },
  deps: PruneDeps,
): Promise<{ removed: string[] }> {
  const runtime = await resolveRuntime();
  const allTags = await deps.listTags(runtime);
  const referenced = await deps.listActiveSandboxTags();
  const { toRemove } = categorizeImages(allTags, {
    legacy: opts.legacy,
    currentBaseTag: opts.currentBaseTag,
    referencedSandboxTags: referenced,
  });
  if (opts.dryRun) return { removed: toRemove };
  for (const tag of toRemove) {
    await deps.remove(runtime, tag);
  }
  return { removed: toRemove };
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

export async function defaultRemove(runtime: Runtime, tag: string): Promise<void> {
  const proc = Bun.spawn([runtime, "image", "rm", tag], {
    stdout: "ignore",
    stderr: "inherit",
  });
  await proc.exited;
}
