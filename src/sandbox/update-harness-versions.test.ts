import { describe, expect, it } from "bun:test";
import { updateHarnessVersions } from "./update-harness-versions";

const HEADER = `# .openlock/Containerfile — your sandbox image. Edit freely.
FROM ghcr.io/vessux/openlock-base:abc123def456
ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000
`;

function containerfile(harnessBlock: string): string {
  return `${HEADER}
# ---- Harness ---------------------------------------------------------------
# Add/remove harness installs below. Keep the final USER directive.
${harnessBlock}
`;
}

describe("updateHarnessVersions", () => {
  it("updates both harnesses when both are present", () => {
    const before = containerfile(`USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.100
RUN npm install -g opencode-ai@1.15.0
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`);

    const { content, updates } = updateHarnessVersions(before, {
      claude_code: "2.1.128",
      opencode: "1.15.5",
    });

    expect(content).toContain("RUN npm install -g @anthropic-ai/claude-code@2.1.128");
    expect(content).toContain("RUN npm install -g opencode-ai@1.15.5");
    expect(content).not.toContain("@2.1.100");
    expect(content).not.toContain("opencode-ai@1.15.0");

    expect(updates).toEqual([
      {
        harness: "claude_code",
        found: true,
        previousVersion: "2.1.100",
        newVersion: "2.1.128",
        changed: true,
      },
      {
        harness: "opencode",
        found: true,
        previousVersion: "1.15.0",
        newVersion: "1.15.5",
        changed: true,
      },
    ]);
  });

  it("reports the other harness as not found when only one is installed", () => {
    const before = containerfile(`USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.100
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`);

    const { content, updates } = updateHarnessVersions(before, {
      claude_code: "2.1.128",
      opencode: "1.15.5",
    });

    expect(content).toContain("RUN npm install -g @anthropic-ai/claude-code@2.1.128");
    expect(updates.find((u) => u.harness === "claude_code")).toEqual({
      harness: "claude_code",
      found: true,
      previousVersion: "2.1.100",
      newVersion: "2.1.128",
      changed: true,
    });
    expect(updates.find((u) => u.harness === "opencode")).toEqual({
      harness: "opencode",
      found: false,
      newVersion: "1.15.5",
      changed: false,
    });
  });

  it("preserves a user's own npm install line for an unrelated tool", () => {
    const before = containerfile(`USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.100
RUN npm install -g some-other-cli@3.0.0
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`);

    const { content } = updateHarnessVersions(before, { claude_code: "2.1.128" });

    expect(content).toContain("RUN npm install -g some-other-cli@3.0.0");
    expect(content).toContain("RUN npm install -g @anthropic-ai/claude-code@2.1.128");
  });

  it("preserves user comments and edits elsewhere in the file", () => {
    const before = `# my own header comment
FROM ghcr.io/vessux/openlock-base:abc123def456
# a custom ARG I added
ARG MY_CUSTOM_ARG=1

# ---- Harness ---------------------------------------------------------------
# Add/remove harness installs below. Keep the final USER directive.
USER root
# installing claude code
RUN npm install -g @anthropic-ai/claude-code@2.1.100
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}
`;

    const { content } = updateHarnessVersions(before, { claude_code: "2.1.128" });

    expect(content).toContain("# my own header comment");
    expect(content).toContain("# a custom ARG I added");
    expect(content).toContain("ARG MY_CUSTOM_ARG=1");
    expect(content).toContain("# installing claude code");
    expect(content).toContain("RUN npm install -g @anthropic-ai/claude-code@2.1.128");
  });

  it("throws when the harness sentinel is missing", () => {
    const before = `FROM ghcr.io/vessux/openlock-base:abc123def456\nRUN npm install -g @anthropic-ai/claude-code@2.1.100\n`;
    expect(() => updateHarnessVersions(before, { claude_code: "2.1.128" })).toThrow(
      "couldn't find harness sentinel",
    );
  });

  it("is a no-op (changed: false) when already at the target version", () => {
    const before = containerfile(`USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.128
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}`);

    const { content, updates } = updateHarnessVersions(before, { claude_code: "2.1.128" });

    expect(content).toBe(before);
    expect(updates).toEqual([
      {
        harness: "claude_code",
        found: true,
        previousVersion: "2.1.128",
        newVersion: "2.1.128",
        changed: false,
      },
    ]);
  });
});
