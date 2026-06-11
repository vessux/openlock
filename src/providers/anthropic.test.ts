import { describe, expect, it } from "bun:test";
import { ANTHROPIC } from "./anthropic";

describe("ANTHROPIC plugin", () => {
  it("declares identity and openshell type", () => {
    expect(ANTHROPIC.id).toBe("anthropic");
    expect(ANTHROPIC.openshellType).toBe("claude");
    expect(ANTHROPIC.credentialEnvVars).toEqual(["ANTHROPIC_BEARER_TOKEN", "ANTHROPIC_AUTH_TOKEN"]);
  });

  it("is compatible with claude_code and opencode", () => {
    expect(ANTHROPIC.compatibleHarnesses.has("claude_code")).toBe(true);
    expect(ANTHROPIC.compatibleHarnesses.has("opencode")).toBe(true);
  });

  describe("policyEndpoints", () => {
    it("uses OAuth-bearer cred_inject for claude_code", () => {
      const endpoints = ANTHROPIC.policyEndpoints("claude_code");
      expect(endpoints).toHaveLength(1);
      const e = endpoints[0];
      expect(e.host).toBe("api.anthropic.com");
      expect(e.cred_inject?.inject).toEqual([
        { header: "Authorization", from_credential: "ANTHROPIC_BEARER_TOKEN" },
      ]);
      expect(e.cred_inject?.strip_headers).toContain("Authorization");
      expect(e.cred_inject?.strip_headers).toContain("x-api-key");
      expect(e.cred_inject?.strip_headers).toContain("Cookie");
    });

    it("uses x-api-key cred_inject for opencode", () => {
      const endpoints = ANTHROPIC.policyEndpoints("opencode");
      expect(endpoints).toHaveLength(1);
      const e = endpoints[0];
      expect(e.host).toBe("api.anthropic.com");
      expect(e.cred_inject?.inject).toEqual([
        { header: "x-api-key", from_credential: "ANTHROPIC_API_KEY" },
      ]);
      expect(e.cred_inject?.strip_headers).toContain("Authorization");
      expect(e.cred_inject?.strip_headers).toContain("x-api-key");
      expect(e.cred_inject?.strip_headers).toContain("Cookie");
    });
  });

  describe("sandboxEnvPlaceholders", () => {
    it("returns empty for claude_code (OAuth-bearer flow)", () => {
      expect(ANTHROPIC.sandboxEnvPlaceholders("claude_code")).toEqual({});
    });

    it("returns ANTHROPIC_API_KEY placeholder for opencode", () => {
      expect(ANTHROPIC.sandboxEnvPlaceholders("opencode")).toEqual({
        ANTHROPIC_API_KEY: "managed-by-openlock-do-not-leak",
      });
    });
  });

  describe("redactionPatterns", () => {
    it("matches Anthropic key shapes", () => {
      const patterns = ANTHROPIC.redactionPatterns();
      const allMatch = (s: string) => patterns.some((re) => new RegExp(re.source).test(s));
      expect(allMatch("sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
      expect(allMatch("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
      expect(allMatch("Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    });
  });
});
