import { describe, expect, it } from "bun:test";
import { OPENROUTER } from "./openrouter";
import type { LoginIO } from "./types";

function makeIO(line: string): LoginIO {
  const out: string[] = [];
  const err: string[] = [];
  return {
    readLine: async () => line,
    writeStdout: (s) => out.push(s),
    writeStderr: (s) => err.push(s),
    isTTY: false,
  };
}

describe("OPENROUTER plugin", () => {
  it("declares identity", () => {
    expect(OPENROUTER.id).toBe("openrouter");
    expect(OPENROUTER.openshellType).toBe("generic");
    expect(OPENROUTER.credentialEnvVars).toEqual(["OPENROUTER_BEARER_TOKEN"]);
  });

  it("is compatible with opencode (not claude_code)", () => {
    expect(OPENROUTER.compatibleHarnesses.has("opencode")).toBe(true);
    expect(OPENROUTER.compatibleHarnesses.has("claude_code")).toBe(false);
  });

  describe("loginInteractive", () => {
    it("returns { OPENROUTER_BEARER_TOKEN } with Bearer prefix when prefix and length valid", async () => {
      const creds = await OPENROUTER.loginInteractive(
        makeIO("sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      );
      expect(creds).toEqual({
        OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
    });
    it("rejects empty input", async () => {
      await expect(OPENROUTER.loginInteractive(makeIO(""))).rejects.toThrow(/empty/i);
    });
    it("rejects keys without sk-or- prefix", async () => {
      await expect(OPENROUTER.loginInteractive(makeIO("wrong-key-prefix"))).rejects.toThrow(
        /sk-or-/,
      );
    });
    it("rejects too-short keys (< 20 chars)", async () => {
      await expect(OPENROUTER.loginInteractive(makeIO("sk-or-tooshort"))).rejects.toThrow(
        /too short/i,
      );
    });
    it("trims whitespace before validation", async () => {
      const creds = await OPENROUTER.loginInteractive(
        makeIO("  sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"),
      );
      expect(creds.OPENROUTER_BEARER_TOKEN).toBe("Bearer sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    });
  });

  describe("policyEndpoints", () => {
    it("emits openrouter.ai with Authorization Bearer cred_inject", () => {
      const endpoints = OPENROUTER.policyEndpoints("opencode");
      const openrouter = endpoints.find((e) => e.host === "openrouter.ai");
      expect(openrouter).toBeDefined();
      expect(openrouter?.cred_inject?.inject).toEqual([
        { header: "Authorization", from_credential: "OPENROUTER_BEARER_TOKEN" },
      ]);
      expect(openrouter?.cred_inject?.strip_headers).toContain("Authorization");
      expect(openrouter?.cred_inject?.strip_headers).toContain("x-api-key");
      expect(openrouter?.cred_inject?.strip_headers).toContain("Cookie");
    });

    it("emits a models.dev read-only GET endpoint with no cred_inject (opencode model metadata)", () => {
      const endpoints = OPENROUTER.policyEndpoints("opencode");
      const modelsDev = endpoints.find((e) => e.host === "models.dev");
      expect(modelsDev).toBeDefined();
      expect(modelsDev?.port).toBe(443);
      expect(modelsDev?.protocol).toBe("rest");
      expect(modelsDev?.rules).toEqual([{ allow: { method: "GET", path: "/**" } }]);
      // public read-only metadata carries no credential
      expect(modelsDev?.cred_inject).toBeUndefined();
    });
  });

  describe("sandboxEnvPlaceholders", () => {
    it("returns OPENROUTER_API_KEY placeholder for opencode", () => {
      expect(OPENROUTER.sandboxEnvPlaceholders("opencode")).toEqual({
        OPENROUTER_API_KEY: "managed-by-openlock-do-not-leak",
      });
    });
  });

  describe("redactionPatterns", () => {
    it("matches sk-or-* shapes", () => {
      const patterns = OPENROUTER.redactionPatterns();
      const allMatch = (s: string) => patterns.some((re) => new RegExp(re.source).test(s));
      expect(allMatch("sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
      expect(allMatch("sk-or-AAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    });
  });
});
