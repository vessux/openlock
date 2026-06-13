import yaml from "js-yaml";
import type { ProviderRefreshMaterial } from "../tokens";

/** The custom openshell provider-profile id for the Claude OAuth subscription
 * provider. Used as the profile's `id` and as the key for the existence probe
 * (`provider profile export <id>`) that gates the non-idempotent import. */
export const CLAUDE_OAUTH_PROFILE_ID = "claude-oauth";

/**
 * Build the openshell runtime provider-profile YAML for the Claude OAuth
 * subscription provider. Importing this profile (when absent) gives the
 * gateway the `token_url`, `scopes`, and `refresh_before_seconds` it needs to
 * mint fresh access tokens — these are NOT expressible as `provider refresh
 * configure` flags, so they must come from the profile.
 *
 * Only the material SCHEMA (which keys exist, which are secret) lives in the
 * profile; the actual `client_id` / `refresh_token` VALUES are supplied later
 * via `--material` at configure time and never written to this file.
 */
export function buildClaudeOAuthProfileYaml(m: ProviderRefreshMaterial): string {
  return yaml.dump({
    id: CLAUDE_OAUTH_PROFILE_ID,
    display_name: "Claude (OAuth subscription)",
    category: "agent",
    inference_capable: true,
    credentials: [
      {
        name: "ANTHROPIC_BEARER_TOKEN",
        env_vars: ["ANTHROPIC_BEARER_TOKEN"],
        required: false,
        auth_style: "header",
        header_name: "authorization",
        refresh: {
          strategy: "oauth2_refresh_token",
          token_url: m.token_url,
          scopes: m.scopes,
          refresh_before_seconds: 300,
          material: [
            { name: "client_id", required: true },
            { name: "refresh_token", required: true, secret: true },
          ],
        },
      },
    ],
    endpoints: [
      {
        host: "api.anthropic.com",
        port: 443,
        protocol: "rest",
        access: "read-write",
        enforcement: "enforce",
      },
    ],
  });
}
