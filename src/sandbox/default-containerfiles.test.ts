import { describe, expect, it } from "bun:test";
import { DEFAULT_CONTAINERFILES } from "./default-containerfiles";

describe("DEFAULT_CONTAINERFILES", () => {
  it("contains all 4 cap permutations", () => {
    expect(Object.keys(DEFAULT_CONTAINERFILES).sort()).toEqual([
      "core",
      "core-js",
      "core-js-py",
      "core-py",
    ]);
  });

  it("each entry pins the ubuntu base by digest", () => {
    for (const [key, content] of Object.entries(DEFAULT_CONTAINERFILES)) {
      expect(content, key).toMatch(/^FROM ubuntu:24\.04@sha256:[0-9a-f]{64}$/m);
    }
  });

  it("core-js variant installs bun", () => {
    expect(DEFAULT_CONTAINERFILES["core-js"]).toContain("https://bun.sh/install");
    expect(DEFAULT_CONTAINERFILES["core-js-py"]).toContain("https://bun.sh/install");
    expect(DEFAULT_CONTAINERFILES["core-py"]).not.toContain("https://bun.sh/install");
    expect(DEFAULT_CONTAINERFILES.core).not.toContain("https://bun.sh/install");
  });

  it("py variants install python and uv", () => {
    expect(DEFAULT_CONTAINERFILES["core-py"]).toContain("python3");
    expect(DEFAULT_CONTAINERFILES["core-py"]).toContain("astral.sh/uv");
    expect(DEFAULT_CONTAINERFILES["core-js-py"]).toContain("python3");
    expect(DEFAULT_CONTAINERFILES["core-js-py"]).toContain("astral.sh/uv");
    expect(DEFAULT_CONTAINERFILES["core-js"]).not.toContain("astral.sh/uv");
  });

  it("each entry has the claude-code install line", () => {
    for (const [key, content] of Object.entries(DEFAULT_CONTAINERFILES)) {
      expect(content, key).toContain("@anthropic-ai/claude-code@");
    }
  });

  it("each entry has the opencode-ai install line", () => {
    for (const [key, content] of Object.entries(DEFAULT_CONTAINERFILES)) {
      expect(content, key).toContain("opencode-ai@");
    }
  });

  it("harness installs (claude + opencode) come after USER sandbox", () => {
    for (const [key, content] of Object.entries(DEFAULT_CONTAINERFILES)) {
      const userSandboxIdx = content.indexOf("USER sandbox");
      const claudeIdx = content.indexOf("@anthropic-ai/claude-code@");
      const opencodeIdx = content.indexOf("opencode-ai@");
      expect(userSandboxIdx, `${key}: USER sandbox directive missing`).toBeGreaterThan(-1);
      expect(claudeIdx, `${key}: claude install missing`).toBeGreaterThan(-1);
      expect(opencodeIdx, `${key}: opencode install missing`).toBeGreaterThan(-1);
      expect(claudeIdx, `${key}: claude install must come after USER sandbox`).toBeGreaterThan(
        userSandboxIdx,
      );
      expect(opencodeIdx, `${key}: opencode install must come after USER sandbox`).toBeGreaterThan(
        userSandboxIdx,
      );
    }
  });
});
