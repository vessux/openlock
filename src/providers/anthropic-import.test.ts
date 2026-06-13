import { describe, expect, it } from "bun:test";
import { parseClaudeOauthBlob } from "./anthropic-import";

describe("parseClaudeOauthBlob", () => {
  const valid = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-realish",
      refreshToken: "sk-ant-ort01-realish",
      expiresAt: 1893456000000, // 2030-01-01, deterministic
      scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
      subscriptionType: "max",
    },
  });

  it("maps the claudeAiOauth blob to a LoginResult with raw access token", () => {
    const r = parseClaudeOauthBlob(valid);
    expect(r.credentials).toEqual({ ANTHROPIC_BEARER_TOKEN: "sk-ant-oat01-realish" });
    expect(r.refresh?.strategy).toBe("oauth2_refresh_token");
    expect(r.refresh?.token_url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(r.refresh?.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(r.refresh?.refresh_token).toBe("sk-ant-ort01-realish");
    expect(r.refresh?.scopes).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
    ]);
    expect(r.refresh?.access_expires_at).toBe(new Date(1893456000000).toISOString());
  });

  it("accepts a bare blob without the claudeAiOauth wrapper", () => {
    const bare = JSON.stringify({ accessToken: "a", refreshToken: "b", expiresAt: 1893456000000 });
    expect(parseClaudeOauthBlob(bare).credentials.ANTHROPIC_BEARER_TOKEN).toBe("a");
  });

  it("throws on non-JSON input", () => {
    expect(() => parseClaudeOauthBlob("not json")).toThrow(/not valid JSON/);
  });

  it("throws when accessToken or refreshToken is missing", () => {
    const noRefresh = JSON.stringify({ claudeAiOauth: { accessToken: "a" } });
    expect(() => parseClaudeOauthBlob(noRefresh)).toThrow(/accessToken\/refreshToken/);
  });

  it("falls back to a ~1h future expiry when expiresAt is absent/non-numeric", () => {
    const noExp = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b" } });
    const r = parseClaudeOauthBlob(noExp);
    expect(new Date(r.refresh!.access_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("defaults scopes when absent", () => {
    const noScopes = JSON.stringify({
      claudeAiOauth: { accessToken: "a", refreshToken: "b", expiresAt: 1893456000000 },
    });
    expect(parseClaudeOauthBlob(noScopes).refresh?.scopes).toEqual([
      "user:profile",
      "user:inference",
    ]);
  });
});
