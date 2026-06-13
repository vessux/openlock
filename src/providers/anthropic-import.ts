import { createHash } from "node:crypto";
import type { LoginResult } from "./types";

const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_SCOPES = ["user:profile", "user:inference"];

/** Parse the `claudeAiOauth` credential Claude Code stores after `claude auth
 * login` (macOS Keychain secret / Linux .credentials.json) into an openlock
 * LoginResult. The access token is stored RAW (no "Bearer " prefix) — the
 * gateway adds the prefix via the policy cred_inject value_prefix at egress. */
export function parseClaudeOauthBlob(raw: string): LoginResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Claude Code credential is not valid JSON.");
  }
  const o = ((parsed.claudeAiOauth as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
  const accessToken = o.accessToken as string | undefined;
  const refreshToken = o.refreshToken as string | undefined;
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Claude Code credential is missing accessToken/refreshToken (was this a subscription login?).",
    );
  }
  const expiresAtMs =
    typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt)
      ? o.expiresAt
      : Date.now() + 3600_000;
  const scopes =
    Array.isArray(o.scopes) && o.scopes.length > 0 ? (o.scopes as string[]) : [...DEFAULT_SCOPES];
  return {
    credentials: { ANTHROPIC_BEARER_TOKEN: accessToken },
    refresh: {
      strategy: "oauth2_refresh_token",
      token_url: CLAUDE_OAUTH_TOKEN_URL,
      scopes,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
      access_expires_at: new Date(expiresAtMs).toISOString(),
    },
  };
}

/** The macOS Keychain service name Claude Code uses for its credential item
 * when `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set to `dir`. CC builds it as
 * `Claude Code` + OAUTH_FILE_SUFFIX("" for a stock build) + "-credentials" +
 * "-" + sha256(dir.normalize("NFC")).hex.slice(0,8). openlock sets that env to
 * its own throwaway dir, so this is fully deterministic — we read exactly the
 * one item CC just created, never the user's real credential. */
export function claudeKeychainService(dir: string): string {
  const suffix = createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}
