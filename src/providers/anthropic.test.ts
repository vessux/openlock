import { describe, expect, it } from "bun:test";
import { ANTHROPIC } from "./anthropic";

describe("ANTHROPIC plugin (OAuth subscription)", () => {
  it("declares identity and openshell type", () => {
    expect(ANTHROPIC.id).toBe("anthropic");
    expect(ANTHROPIC.openshellType).toBe("claude-oauth");
    expect(ANTHROPIC.credentialEnvVars).toEqual(["ANTHROPIC_BEARER_TOKEN"]);
  });

  it("is compatible with claude_code only (not opencode)", () => {
    expect(ANTHROPIC.compatibleHarnesses.has("claude_code")).toBe(true);
    expect(ANTHROPIC.compatibleHarnesses.has("opencode")).toBe(false);
  });

  describe("policyEndpoints", () => {
    it("uses OAuth-bearer cred_inject with value_prefix for claude_code", () => {
      const endpoints = ANTHROPIC.policyEndpoints("claude_code");
      expect(endpoints).toHaveLength(1);
      const e = endpoints[0];
      expect(e.host).toBe("api.anthropic.com");
      expect(e.cred_inject?.inject).toEqual([
        {
          header: "Authorization",
          from_credential: "ANTHROPIC_BEARER_TOKEN",
          value_prefix: "Bearer ",
        },
      ]);
      expect(e.cred_inject?.strip_headers).toContain("Authorization");
      expect(e.cred_inject?.strip_headers).toContain("x-api-key");
      expect(e.cred_inject?.strip_headers).toContain("Cookie");
    });
  });

  describe("sandboxEnvPlaceholders", () => {
    it("returns empty for claude_code (OAuth-file flow, no env placeholder)", () => {
      expect(ANTHROPIC.sandboxEnvPlaceholders("claude_code")).toEqual({});
    });
  });

  describe("sandboxFiles", () => {
    it("stages one OAuth-shaped .credentials.json for claude_code", () => {
      const files = ANTHROPIC.sandboxFiles("claude_code");
      expect(files).toHaveLength(1);
      const f = files[0];
      expect(f.sandboxPath).toBe("/sandbox/.openlock/claude-config/.credentials.json");
      const parsed = JSON.parse(f.content) as {
        claudeAiOauth?: { accessToken?: string };
      };
      expect(parsed.claudeAiOauth?.accessToken).toMatch(/^sk-ant-oat01-/);
    });

    it("stages nothing for opencode", () => {
      expect(ANTHROPIC.sandboxFiles("opencode")).toEqual([]);
    });
  });

  describe("redactionPatterns", () => {
    it("matches oat01 and ort01 token shapes", () => {
      const patterns = ANTHROPIC.redactionPatterns();
      const allMatch = (s: string) => patterns.some((re) => new RegExp(re.source).test(s));
      expect(allMatch("sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
      expect(allMatch("sk-ant-ort01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
      expect(allMatch("Bearer sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    });
  });
});
