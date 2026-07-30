import type { Harness } from "./harness";

/**
 * Single source of truth for the npm package pinned into the sandbox image
 * per harness, plus the npm dist-tag a future `update-harness` command
 * should resolve against to propose a bump.
 *
 * The dist-tag differs per harness and this is load-bearing, so don't
 * "simplify" it to one shared tag:
 * - `@anthropic-ai/claude-code` publishes a curated `stable` tag (currently
 *   2.1.212, distinct from `latest` 2.1.220) and these run in every sandbox,
 *   so `stable` is the right resolution target.
 * - `opencode-ai` publishes NO `stable` tag at all — verified 2026-07-29
 *   against the registry, it has only `latest` plus ~40 `snapshot-*` tags —
 *   so its resolution target is `latest`.
 */
export const HARNESS_VERSIONS: Record<
  Harness,
  { package: string; version: string; distTag: string }
> = {
  claude_code: {
    package: "@anthropic-ai/claude-code",
    version: "2.1.212",
    distTag: "stable",
  },
  opencode: {
    package: "opencode-ai",
    version: "1.18.9",
    distTag: "latest",
  },
};

/** Renders the `npm install` line for a harness at a given version. */
export function harnessInstallLine(harness: Harness, version: string): string {
  return `RUN npm install -g ${HARNESS_VERSIONS[harness].package}@${version}`;
}
