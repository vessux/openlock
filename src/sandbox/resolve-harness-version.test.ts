import { describe, expect, it } from "bun:test";
import type { DistTags } from "./resolve-harness-version";
import { resolveHarnessVersion } from "./resolve-harness-version";

describe("resolveHarnessVersion", () => {
  it("picks the configured dist-tag (stable) for claude_code", async () => {
    const tags: DistTags = { stable: "2.1.212", latest: "2.1.220", next: "2.1.220" };
    const version = await resolveHarnessVersion("claude_code", async (pkg) => {
      expect(pkg).toBe("@anthropic-ai/claude-code");
      return tags;
    });
    expect(version).toBe("2.1.212");
  });

  it("picks the configured dist-tag (latest) for opencode", async () => {
    const tags: DistTags = { latest: "1.18.9", dev: "0.0.0-dev-1" };
    const version = await resolveHarnessVersion("opencode", async (pkg) => {
      expect(pkg).toBe("opencode-ai");
      return tags;
    });
    expect(version).toBe("1.18.9");
  });

  it("hard-errors (no fallback) when the configured dist-tag is absent", async () => {
    const tags: DistTags = { latest: "2.1.220", next: "2.1.220" };
    await expect(resolveHarnessVersion("claude_code", async () => tags)).rejects.toThrow(
      /dist-tag "stable" not found for claude_code.*Available tags: latest, next/,
    );
  });
});
