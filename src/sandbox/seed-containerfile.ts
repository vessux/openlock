import { computeBaseTag, GHCR_BASE_PREFIX } from "./ensure-base";
import type { Harness } from "./harness";
import { HARNESS_VERSIONS, harnessInstallLine } from "./harness-versions";
import { BASE_CONTAINERFILE } from "./image-build";
import { HARNESS_SENTINEL } from "./update-containerfile";

/** In-image sandbox user uid; must match the ARG in base.Containerfile / generators. */
export const SANDBOX_UID = 60000;

function multiHarnessBlock(
  harnesses: Harness[],
  versions: Partial<Record<Harness, string>> | undefined,
): string {
  const installs = harnesses.map((h) =>
    harnessInstallLine(h, versions?.[h] ?? HARNESS_VERSIONS[h].version),
  );
  // NOTE (openlock-5wk): the claude_code install used to also bake an
  // onboarding-skip $HOME/.claude.json copy into this rendered block. That
  // copy was dead weight — container.ts sets CLAUDE_CONFIG_DIR
  // unconditionally for claude_code, so CC never reads $HOME/.claude.json;
  // the copy that actually takes effect is staged into CLAUDE_CONFIG_DIR by
  // ANTHROPIC.sandboxFiles() (src/providers/anthropic.ts). Removed rather
  // than kept in sync as a decoy.
  return `USER root
${installs.join("\n")}
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`;
}

function inlineComment(content: string): string {
  return content
    .split("\n")
    .map((line) => (line.length === 0 ? "#" : `# ${line}`))
    .join("\n");
}

export interface SeedContainerfileArgs {
  harnesses: Harness[];
  baseHash: string;
  baseContent: string;
  /** Per-harness install version override. Any harness missing from this map
   * falls back to its pinned constant in ./harness-versions. Overridable so
   * the fixture tests don't churn on every version bump. */
  versions?: Partial<Record<Harness, string>>;
}

/** Full Containerfile contents seeded for a single harness, using the embedded
 * base image hash. Shared by `openlock init` and the folder helpers. */
export function renderSeedContainerfile(harness: Harness): string {
  const baseHash = computeBaseTag(BASE_CONTAINERFILE).slice(GHCR_BASE_PREFIX.length);
  return seedContainerfile({ harnesses: [harness], baseHash, baseContent: BASE_CONTAINERFILE });
}

export function seedContainerfile(args: SeedContainerfileArgs): string {
  if (args.harnesses.length === 0) {
    throw new Error("seedContainerfile: at least one harness required");
  }
  const harnessBlock = multiHarnessBlock(args.harnesses, args.versions);

  return `# .openlock/Containerfile — your sandbox image. Edit freely.
#
# Default: pull the openlock-maintained base image (fast, content-hashed).
# To customize the base, comment out the FROM + the two ARGs below, then
# uncomment EVERYTHING in the inline reference block (including its ARGs).
# Source: github.com/vessux/openlock/containers/base.Containerfile
#
FROM ghcr.io/vessux/openlock-base:${args.baseHash}

# Sandbox uid/gid — must match the base image's user. The openshell fork
# parses Config.User from the image and applies userns mapping; keep numeric.
ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000

# ---- Base image (inline reference) ----------------------------------------
# Build the base locally instead of pulling: comment out FROM + ARGs above,
# uncomment everything below.
#
${inlineComment(args.baseContent)}

${HARNESS_SENTINEL}
# Add/remove harness installs below. Keep the final USER directive.
${harnessBlock}
`;
}
