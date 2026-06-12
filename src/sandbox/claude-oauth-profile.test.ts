import { describe, expect, it } from "bun:test";
import yaml from "js-yaml";
import type { ProviderRefreshMaterial } from "../tokens";
import { buildClaudeOAuthProfileYaml } from "./claude-oauth-profile";

const material: ProviderRefreshMaterial = {
  strategy: "oauth2_refresh_token",
  token_url: "https://console.anthropic.com/v1/oauth/token",
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
  client_id: "client-abc",
  refresh_token: "rt-secret",
  access_expires_at: "2026-06-12T12:00:00Z",
};

describe("buildClaudeOAuthProfileYaml", () => {
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML is dynamically shaped in tests.
  const parsed = yaml.load(buildClaudeOAuthProfileYaml(material)) as any;

  it("has top-level id 'claude-oauth'", () => {
    expect(parsed.id).toBe("claude-oauth");
  });

  it("declares exactly one credential named ANTHROPIC_BEARER_TOKEN", () => {
    expect(parsed.credentials).toHaveLength(1);
    expect(parsed.credentials[0].name).toBe("ANTHROPIC_BEARER_TOKEN");
  });

  it("uses the snake_case refresh strategy", () => {
    expect(parsed.credentials[0].refresh.strategy).toBe("oauth2_refresh_token");
  });

  it("carries token_url and scopes from the material", () => {
    expect(parsed.credentials[0].refresh.token_url).toBe(material.token_url);
    expect(parsed.credentials[0].refresh.scopes).toEqual(material.scopes);
  });

  it("declares the material SCHEMA only (no client_id/refresh_token values)", () => {
    expect(parsed.credentials[0].refresh.material).toEqual([
      { name: "client_id", required: true },
      { name: "refresh_token", required: true, secret: true },
    ]);
    const serialized = buildClaudeOAuthProfileYaml(material);
    expect(serialized).not.toContain(material.client_id);
    expect(serialized).not.toContain(material.refresh_token);
  });
});
