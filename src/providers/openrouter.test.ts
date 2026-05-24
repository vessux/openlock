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
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0].host).toBe("openrouter.ai");
      expect(endpoints[0].cred_inject.inject).toEqual([
        { header: "Authorization", from_credential: "OPENROUTER_BEARER_TOKEN" },
      ]);
      expect(endpoints[0].cred_inject.strip_headers).toContain("Authorization");
      expect(endpoints[0].cred_inject.strip_headers).toContain("x-api-key");
      expect(endpoints[0].cred_inject.strip_headers).toContain("Cookie");
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
