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
      expect(endpoints).toHaveLength(2);
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

    it("allows the unconditional CC startup connectivity probe on api.anthropic.com", () => {
      const endpoints = ANTHROPIC.policyEndpoints("claude_code");
      const e = endpoints.find((ep) => ep.host === "api.anthropic.com");
      expect(e?.rules).toEqual(
        expect.arrayContaining([
          { allow: { method: "POST", path: "/v1/**" } },
          { allow: { method: "GET", path: "/api/hello" } },
        ]),
      );
    });

    it("declares platform.claude.com with its own cred_inject for the oauth/hello probe", () => {
      const endpoints = ANTHROPIC.policyEndpoints("claude_code");
      const e = endpoints.find((ep) => ep.host === "platform.claude.com");
      expect(e).toBeDefined();
      expect(e?.port).toBe(443);
      expect(e?.rules).toEqual([{ allow: { method: "GET", path: "/v1/oauth/hello" } }]);
      // Separate host => separate endpoint block => must carry its OWN
      // cred_inject, otherwise the placeholder token forwards verbatim and
      // upstream answers 401 (strictly worse than a blocked connection).
      expect(e?.cred_inject?.inject).toEqual([
        {
          header: "Authorization",
          from_credential: "ANTHROPIC_BEARER_TOKEN",
          value_prefix: "Bearer ",
        },
      ]);
      expect(e?.cred_inject?.strip_headers).toContain("Authorization");
      expect(e?.cred_inject?.strip_headers).toContain("x-api-key");
      expect(e?.cred_inject?.strip_headers).toContain("Cookie");
    });
  });

  describe("sandboxEnvPlaceholders", () => {
    it("returns empty for claude_code (OAuth-file flow, no env placeholder)", () => {
      expect(ANTHROPIC.sandboxEnvPlaceholders("claude_code")).toEqual({});
    });
  });

  describe("sandboxFiles", () => {
    it("stages the OAuth-shaped .credentials.json and a .claude.json for claude_code", () => {
      const files = ANTHROPIC.sandboxFiles("claude_code");
      expect(files).toHaveLength(2);
      const creds = files.find((f) => f.sandboxPath.endsWith(".credentials.json"));
      expect(creds?.sandboxPath).toBe("/sandbox/.openlock/claude-config/.credentials.json");
      const parsed = JSON.parse(creds?.content ?? "{}") as {
        claudeAiOauth?: { accessToken?: string };
      };
      expect(parsed.claudeAiOauth?.accessToken).toMatch(/^sk-ant-oat01-/);
    });

    it("stages .claude.json in CLAUDE_CONFIG_DIR with onboarding flags and an inert oauthAccount stub", () => {
      const files = ANTHROPIC.sandboxFiles("claude_code");
      const configFile = files.find((f) => f.sandboxPath.endsWith("/.claude.json"));
      expect(configFile).toBeDefined();
      // Must land in CLAUDE_CONFIG_DIR (set by container.ts for claude_code),
      // not $HOME — CC only reads onboarding state from CLAUDE_CONFIG_DIR when
      // that env var is set, and the image-baked $HOME/.claude.json is never
      // consulted.
      expect(configFile?.sandboxPath).toBe("/sandbox/.openlock/claude-config/.claude.json");
      const parsed = JSON.parse(configFile?.content ?? "{}") as {
        hasCompletedOnboarding?: boolean;
        hasTrustDialogAccepted?: boolean;
        lastOnboardingVersion?: string;
        oauthAccount?: {
          accountUuid?: string;
          emailAddress?: string;
          organizationUuid?: string;
          organizationName?: string;
          organizationRole?: string;
          workspaceRole?: string | null;
        };
      };
      expect(parsed.hasCompletedOnboarding).toBe(true);
      expect(parsed.hasTrustDialogAccepted).toBe(true);
      expect(parsed.lastOnboardingVersion).toBeDefined();
      // Without an oauthAccount record CC does not consider itself
      // authenticated even with a valid .credentials.json present. This exact
      // shape (all-zero/all-one UUIDs, .local email, null workspaceRole) is
      // live-verified against CC 2.1.128 on 2026-07-27 (authrepro-5edca7
      // sandbox: started straight into a prompt, reported Claude Max) and
      // re-verified unchanged against CC 2.1.212 on 2026-07-29 (openlock-nna,
      // sandbox nna-cc-53866a: same result, real inference round-tripped) — assert
      // the precise values, not a substring match, since an unparseable UUID
      // (e.g. non-hex characters in the last group) would silently regress CC
      // to the login selector without failing a loose "is defined" check.
      expect(parsed.oauthAccount).toEqual({
        accountUuid: "00000000-0000-0000-0000-000000000000",
        emailAddress: "sandbox@openlock.local",
        organizationUuid: "00000000-0000-0000-0000-000000000001",
        organizationName: "openlock",
        organizationRole: "admin",
        workspaceRole: null,
      });
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
