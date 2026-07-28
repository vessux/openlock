import { computeBaseTag, GHCR_BASE_PREFIX } from "./ensure-base";
import type { Harness } from "./harness";
import { BASE_CONTAINERFILE } from "./image-build";
import { HARNESS_SENTINEL } from "./update-containerfile";

/** In-image sandbox user uid; must match the ARG in base.Containerfile / generators. */
export const SANDBOX_UID = 60000;

function multiHarnessBlock(harnesses: Harness[]): string {
  const installs: string[] = [];
  for (const h of harnesses) {
    if (h === "claude_code") {
      installs.push(`RUN npm install -g @anthropic-ai/claude-code@2.1.128`);
    } else if (h === "opencode") {
      installs.push(`RUN npm install -g opencode-ai@1.15.5`);
    }
  }
  return `USER root
${installs.join("\n")}
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`;
}

// NOTE (openlock-5wk): claude_code used to also bake an onboarding-skip
// $HOME/.claude.json here. That copy was dead weight — container.ts sets
// CLAUDE_CONFIG_DIR unconditionally for claude_code, so CC never reads
// $HOME/.claude.json; the copy that actually takes effect is staged into
// CLAUDE_CONFIG_DIR by ANTHROPIC.sandboxFiles() (src/providers/anthropic.ts).
// Removed rather than kept in sync as a decoy.
const HARNESS_FRAGMENTS: Record<Harness, string> = {
  claude_code: `USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.128
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`,
  opencode: `USER root
RUN npm install -g opencode-ai@1.15.5
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`,
};

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
  const harnessBlock =
    args.harnesses.length === 1
      ? HARNESS_FRAGMENTS[args.harnesses[0]]
      : multiHarnessBlock(args.harnesses);

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
