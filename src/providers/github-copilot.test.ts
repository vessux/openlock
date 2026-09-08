import { describe, expect, it } from "bun:test";
import { GITHUB_COPILOT } from "./github-copilot";
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

describe("GITHUB_COPILOT plugin", () => {
  it("declares identity", () => {
    expect(GITHUB_COPILOT.id).toBe("github_copilot");
    expect(GITHUB_COPILOT.openshellType).toBe("generic");
    expect(GITHUB_COPILOT.credentialEnvVars).toEqual(["GITHUB_COPILOT_PAT"]);
  });

  it("is compatible with copilot_cli ONLY", () => {
    expect(GITHUB_COPILOT.compatibleHarnesses.has("copilot_cli")).toBe(true);
    expect(GITHUB_COPILOT.compatibleHarnesses.has("opencode")).toBe(false);
    expect(GITHUB_COPILOT.compatibleHarnesses.has("pi")).toBe(false);
    expect(GITHUB_COPILOT.compatibleHarnesses.has("claude_code")).toBe(false);
  });

  describe("loginInteractive", () => {
    it("returns { credentials: { GITHUB_COPILOT_PAT } } with the raw token, no prefix", async () => {
      const result = await GITHUB_COPILOT.loginInteractive(
        makeIO("github_pat_AAAAAAAAAAAAAAAAAAAAAAA"),
      );
      expect(result).toEqual({
        credentials: { GITHUB_COPILOT_PAT: "github_pat_AAAAAAAAAAAAAAAAAAAAAAA" },
      });
    });

    it("trims whitespace before validation", async () => {
      const result = await GITHUB_COPILOT.loginInteractive(
        makeIO("  github_pat_AAAAAAAAAAAAAAAAAAAAAAA\n"),
      );
      expect(result.credentials.GITHUB_COPILOT_PAT).toBe("github_pat_AAAAAAAAAAAAAAAAAAAAAAA");
    });

    it("rejects empty input", async () => {
      await expect(GITHUB_COPILOT.loginInteractive(makeIO(""))).rejects.toThrow(/empty/i);
    });

    it("rejects classic ghp_ tokens, naming the fine-grained + Copilot Requests requirement", async () => {
      await expect(
        GITHUB_COPILOT.loginInteractive(makeIO("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")),
      ).rejects.toThrow(/fine-grained/i);
      await expect(
        GITHUB_COPILOT.loginInteractive(makeIO("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")),
      ).rejects.toThrow(/Copilot Requests/);
    });

    it("rejects classic gho_ tokens the same way", async () => {
      await expect(
        GITHUB_COPILOT.loginInteractive(makeIO("gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")),
      ).rejects.toThrow(/fine-grained/i);
    });

    it("requires the github_pat_ prefix, rejecting anything else", async () => {
      await expect(GITHUB_COPILOT.loginInteractive(makeIO("wrong-token-shape"))).rejects.toThrow(
        /fine-grained/i,
      );
    });
  });

  describe("policyEndpoints", () => {
    it("emits api.github.com with Authorization Bearer cred_inject", () => {
      const endpoints = GITHUB_COPILOT.policyEndpoints("copilot_cli");
      const gh = endpoints.find((e) => e.host === "api.github.com");
      expect(gh).toBeDefined();
      expect(gh?.cred_inject?.inject).toEqual([
        { header: "Authorization", from_credential: "GITHUB_COPILOT_PAT", value_prefix: "Bearer " },
      ]);
      expect(gh?.cred_inject?.strip_headers).toContain("Authorization");
      expect(gh?.cred_inject?.strip_headers).toContain("x-api-key");
      expect(gh?.cred_inject?.strip_headers).toContain("Cookie");
    });

    it("enumerates all three known Copilot inference hosts, each with cred_inject", () => {
      const endpoints = GITHUB_COPILOT.policyEndpoints("copilot_cli");
      const hosts = [
        "api.individual.githubcopilot.com",
        "api.business.githubcopilot.com",
        "api.enterprise.githubcopilot.com",
      ];
      for (const host of hosts) {
        const ep = endpoints.find((e) => e.host === host);
        expect(ep).toBeDefined();
        expect(ep?.cred_inject?.inject).toEqual([
          {
            header: "Authorization",
            from_credential: "GITHUB_COPILOT_PAT",
            value_prefix: "Bearer ",
          },
        ]);
      }
    });

    // openlock-ag09, live-captured 2026-09-08: the CLI's real request
    // sequence against the inference host includes these four paths beyond
    // the original guessed set — denying any of them surfaces in the CLI as
    // an opaque "Authorization error" rather than a clear policy-deny.
    it("allows the live-captured request sequence on every inference host (/models/session/intent, /v1/messages, /mcp/readonly, /auto)", () => {
      const endpoints = GITHUB_COPILOT.policyEndpoints("copilot_cli");
      const inferenceHosts = [
        "api.individual.githubcopilot.com",
        "api.business.githubcopilot.com",
        "api.enterprise.githubcopilot.com",
      ];
      const liveCapturedRules = [
        { method: "POST", path: "/models/session/intent" },
        { method: "POST", path: "/v1/messages" },
        { method: "POST", path: "/mcp/readonly" },
        { method: "POST", path: "/auto" },
      ];
      for (const host of inferenceHosts) {
        const ep = endpoints.find((e) => e.host === host);
        expect(ep).toBeDefined();
        for (const rule of liveCapturedRules) {
          expect(ep?.rules).toContainEqual({ allow: rule });
        }
      }
    });

    it("does NOT emit a telemetry host (default-deny)", () => {
      const endpoints = GITHUB_COPILOT.policyEndpoints("copilot_cli");
      expect(endpoints.find((e) => e.host.includes("telemetry"))).toBeUndefined();
    });
  });

  describe("sandboxEnvPlaceholders", () => {
    it("returns a token-shaped COPILOT_GITHUB_TOKEN placeholder", () => {
      const placeholders = GITHUB_COPILOT.sandboxEnvPlaceholders("copilot_cli");
      expect(Object.keys(placeholders)).toEqual(["COPILOT_GITHUB_TOKEN"]);
      expect(placeholders.COPILOT_GITHUB_TOKEN).toMatch(/^github_pat_/);
    });
  });

  describe("redactionPatterns", () => {
    it("matches github_pat_ and ghp_/gho_ shapes", () => {
      const patterns = GITHUB_COPILOT.redactionPatterns();
      const allMatch = (s: string) => patterns.some((re) => new RegExp(re.source).test(s));
      expect(allMatch("github_pat_AAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
      expect(allMatch("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
      expect(allMatch("gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    });
  });
});
