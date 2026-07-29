import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DistTags } from "../sandbox/resolve-harness-version";
import { updateHarnessCmd } from "./update-harness";

function setup(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "openlock-uh-test-"));
  mkdirSync(join(dir, ".openlock"));
  writeFileSync(join(dir, ".openlock/Containerfile"), content);
  return dir;
}

const CONTAINERFILE_BOTH = `FROM ghcr.io/vessux/openlock-base:abc123def456
ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000

# ---- Harness ---------------------------------------------------------------
# Add/remove harness installs below. Keep the final USER directive.
USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.100
RUN npm install -g opencode-ai@1.15.0
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}
`;

const FAKE_TAGS: Record<string, DistTags> = {
  "@anthropic-ai/claude-code": { stable: "2.1.128", latest: "2.1.130" },
  "opencode-ai": { latest: "1.15.5" },
};

async function fakeFetchDistTags(pkg: string): Promise<DistTags> {
  const tags = FAKE_TAGS[pkg];
  if (!tags) throw new Error(`no fake dist-tags configured for ${pkg}`);
  return tags;
}

describe("updateHarnessCmd", () => {
  it("resolves + rewrites both harnesses when both are present", async () => {
    const dir = setup(CONTAINERFILE_BOTH);
    try {
      const exitCode = await updateHarnessCmd(["--project", dir], {
        fetchDistTags: fakeFetchDistTags,
      });
      expect(exitCode).toBe(0);
      const after = readFileSync(join(dir, ".openlock/Containerfile"), "utf-8");
      expect(after).toContain("RUN npm install -g @anthropic-ai/claude-code@2.1.128");
      expect(after).toContain("RUN npm install -g opencode-ai@1.15.5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports already up to date and does not rewrite when nothing changed", async () => {
    const already = CONTAINERFILE_BOTH.replace(
      "claude-code@2.1.100",
      "claude-code@2.1.128",
    ).replace("opencode-ai@1.15.0", "opencode-ai@1.15.5");
    const dir = setup(already);
    try {
      const exitCode = await updateHarnessCmd(["--project", dir], {
        fetchDistTags: fakeFetchDistTags,
      });
      expect(exitCode).toBe(0);
      const after = readFileSync(join(dir, ".openlock/Containerfile"), "utf-8");
      expect(after).toBe(already);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors if Containerfile missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openlock-uh-test-"));
    try {
      const exitCode = await updateHarnessCmd(["--project", dir], {
        fetchDistTags: fakeFetchDistTags,
      });
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors if sentinel missing", async () => {
    const dir = setup(
      "FROM ghcr.io/vessux/openlock-base:abc123def456\nRUN npm install -g @anthropic-ai/claude-code@2.1.100\n",
    );
    try {
      const exitCode = await updateHarnessCmd(["--project", dir], {
        fetchDistTags: fakeFetchDistTags,
      });
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (and skips the misleading 'already up to date' line) for an install line found outside the harness block", async () => {
    // claude_code's install line sits ABOVE the sentinel (a hand-edit); no
    // harness install lines appear after it at all, so nothing here is ever
    // actually looked at by updateHarnessVersions.
    const outsideBlock = `FROM ghcr.io/vessux/openlock-base:abc123def456
ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000
RUN npm install -g @anthropic-ai/claude-code@2.1.100

# ---- Harness ---------------------------------------------------------------
# Add/remove harness installs below. Keep the final USER directive.
USER root
RUN chown -R \${SANDBOX_UID}:\${SANDBOX_GID} /sandbox
USER \${SANDBOX_UID}:\${SANDBOX_GID}
`;
    const dir = setup(outsideBlock);
    const logs: string[] = [];
    const warns: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(((s: string) => {
      logs.push(s);
    }) as never);
    const warnSpy = spyOn(console, "warn").mockImplementation(((s: string) => {
      warns.push(s);
    }) as never);
    try {
      const exitCode = await updateHarnessCmd(["--project", dir], {
        fetchDistTags: fakeFetchDistTags,
      });
      expect(exitCode).toBe(0);
      expect(warns.join("\n")).toContain("claude_code");
      expect(warns.join("\n")).toContain("outside the harness block");
      expect(logs).not.toContain("already up to date");
      const after = readFileSync(join(dir, ".openlock/Containerfile"), "utf-8");
      expect(after).toBe(outsideBlock);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors with a useful message when the configured dist-tag is absent from the registry", async () => {
    const dir = setup(CONTAINERFILE_BOTH);
    try {
      const exitCode = await updateHarnessCmd(["--project", dir], {
        fetchDistTags: async (pkg: string) => {
          if (pkg === "@anthropic-ai/claude-code") return { latest: "2.1.130" }; // no "stable"
          return FAKE_TAGS[pkg] ?? {};
        },
      });
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
