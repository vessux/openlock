const inlineComment = (content: string): string =>
  content
    .split("\n")
    .map((line) => (line.length === 0 ? "#" : `# ${line}`))
    .join("\n");

export const HARNESS_SENTINEL =
  "# ---- Harness ---------------------------------------------------------------";

const GUIDANCE_LINE = "# Add/remove harness installs below. Keep the final USER directive.";

export function extractHarnessBlock(containerfileContent: string): string {
  const idx = containerfileContent.indexOf(HARNESS_SENTINEL);
  if (idx < 0) {
    throw new Error(
      "update-containerfile: couldn't find harness sentinel; refusing to auto-update. " +
        "Edit FROM line manually.",
    );
  }
  let afterSentinel = containerfileContent.slice(idx + HARNESS_SENTINEL.length);
  // Strip the single newline that follows the sentinel line.
  if (afterSentinel.startsWith("\n")) {
    afterSentinel = afterSentinel.slice(1);
  }
  // If the next line is the guidance comment that updateContainerfile re-emits,
  // strip it too — it's not user content.
  if (afterSentinel.startsWith(`${GUIDANCE_LINE}\n`)) {
    afterSentinel = afterSentinel.slice(GUIDANCE_LINE.length + 1);
  }
  // Trim a single trailing newline if the file ends with two (template ends
  // the block with `\n`; seed file adds a final `\n`).
  if (afterSentinel.endsWith("\n\n")) {
    afterSentinel = afterSentinel.slice(0, -1);
  }
  return afterSentinel;
}

export function updateContainerfile(
  current: string,
  newBaseHash: string,
  baseContent: string,
): string {
  const harnessBlock = extractHarnessBlock(current);

  return `# .openlock/Containerfile — your sandbox image. Edit freely.
#
# Default: pull the openlock-maintained base image (fast, content-hashed).
# To customize the base, comment out the FROM + the two ARGs below, then
# uncomment EVERYTHING in the inline reference block (including its ARGs).
# Source: github.com/vessux/openlock/containers/base.Containerfile
#
FROM ghcr.io/vessux/openlock-base:${newBaseHash}

# Sandbox uid/gid — must match the base image's user. The openshell fork
# parses Config.User from the image and applies userns mapping; keep numeric.
ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000

# ---- Base image (inline reference) ----------------------------------------
# Build the base locally instead of pulling: comment out FROM + ARGs above,
# uncomment everything below.
#
${inlineComment(baseContent)}

${HARNESS_SENTINEL}
# Add/remove harness installs below. Keep the final USER directive.
${harnessBlock}`;
}
