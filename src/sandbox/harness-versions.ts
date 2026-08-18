import type { Harness } from "./harness";

/**
 * Single source of truth for the npm package pinned into the sandbox image
 * per harness, plus the npm dist-tag a future `update-harness` command
 * should resolve against to propose a bump.
 *
 * The dist-tag differs per harness and this is load-bearing, so don't
 * "simplify" it to one shared tag:
 * - `@anthropic-ai/claude-code` publishes a curated `stable` tag (currently
 *   2.1.224, distinct from `latest` 2.1.233 and `next` 2.1.234) and these run
 *   in every sandbox, so `stable` is the right resolution target.
 * - `opencode-ai` publishes NO `stable` tag at all — verified 2026-07-29
 *   against the registry, it has only `latest` plus ~40 `snapshot-*` tags —
 *   so its resolution target is `latest`.
 * - `@earendil-works/pi-coding-agent` (installed binary: `pi`) also publishes
 *   NO `stable` tag — re-verified 2026-08-17 against the registry, its
 *   dist-tags are only `latest` (0.84.2) and `legacy-node20` (0.74.2, a Node
 *   20 compatibility line) — so `latest` is its resolution target too. Do not
 *   pin the unscoped `pi-coding-agent` package name: that is an unrelated
 *   placeholder reservation (version 0.0.1, zero dependencies), not the real
 *   package (openlock-1ho).
 */
export const HARNESS_VERSIONS: Record<
  Harness,
  { package: string; version: string; distTag: string }
> = {
  claude_code: {
    package: "@anthropic-ai/claude-code",
    version: "2.1.224",
    distTag: "stable",
  },
  opencode: {
    package: "opencode-ai",
    version: "1.18.18",
    distTag: "latest",
  },
  pi: {
    package: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
    distTag: "latest",
  },
};

/** Renders the `npm install` line for a harness at a given version. */
export function harnessInstallLine(harness: Harness, version: string): string {
  return `RUN npm install -g ${HARNESS_VERSIONS[harness].package}@${version}`;
}
