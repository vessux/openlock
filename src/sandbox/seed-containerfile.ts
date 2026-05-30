import { computeBaseTag, GHCR_BASE_PREFIX } from "./ensure-base";
import type { Harness } from "./harness";
import { BASE_CONTAINERFILE } from "./image-build";
import { HARNESS_SENTINEL } from "./update-containerfile";

function multiHarnessBlock(harnesses: Harness[]): string {
  const installs: string[] = [];
  const postInstalls: string[] = [];
  for (const h of harnesses) {
    if (h === "claude_code") {
      installs.push(`RUN npm install -g @anthropic-ai/claude-code@2.1.128`);
      postInstalls.push(`RUN cat > /sandbox/.claude.json <<'JSON'
{
  "hasCompletedOnboarding": true,
  "hasTrustDialogAccepted": true,
  "lastOnboardingVersion": "9999.99.99",
  "theme": "dark",
  "projects": {
    "/sandbox/repo": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
JSON`);
    } else if (h === "opencode") {
      installs.push(`RUN npm install -g opencode-ai@1.15.5`);
    }
  }
  return `USER root
${installs.join("\n")}
USER \${SANDBOX_UID}:\${SANDBOX_GID}${postInstalls.length > 0 ? `\n${postInstalls.join("\n")}` : ""}`;
}

const HARNESS_FRAGMENTS: Record<Harness, string> = {
  claude_code: `USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.128
USER \${SANDBOX_UID}:\${SANDBOX_GID}
RUN cat > /sandbox/.claude.json <<'JSON'
{
  "hasCompletedOnboarding": true,
  "hasTrustDialogAccepted": true,
  "lastOnboardingVersion": "9999.99.99",
  "theme": "dark",
  "projects": {
    "/sandbox/repo": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
JSON`,
  opencode: `USER root
RUN npm install -g opencode-ai@1.15.5
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
ARG SANDBOX_UID=999999
ARG SANDBOX_GID=999999

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
