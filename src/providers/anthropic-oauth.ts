import { createHash, randomBytes } from "node:crypto";
import { spawn } from "bun";
import type { LoginIO } from "./types";

// OAuth client constants. Per design decision D5 these live in source, not in
// docs/fixtures/policies. The token endpoint is used here for the
// authorization-code exchange and later (gateway-side) for refresh.
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"; // max/subscription mode
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// HOSTED redirect: after consent the page displays a `code#state` string the
// user pastes back. There is no localhost server — this is a fixed constant.
const CLAUDE_OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

/** Real subscription access+refresh token pair captured HOST-side. Never enters
 * the sandbox. */
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** RFC3339 timestamp at which `access_token` expires. */
  expires_at: string;
  client_id: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** PKCE pair: a high-entropy `verifier` and its S256 `challenge`. */
export function buildPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Build the hosted-callback authorize URL. No `redirect_uri` parameter is
 * accepted — the redirect is the fixed hosted constant. */
export function buildAuthorizeUrl(a: { challenge: string; state: string }): string {
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", a.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", a.state);
  // Required for the hosted-callback display flow (renders code#state for paste-back).
  url.searchParams.set("code", "true");
  return url.toString();
}

/** Exchange an authorization code for tokens against the Claude token endpoint. */
export async function exchangeCode(
  a: { code: string; state: string; verifier: string },
  doFetch: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const res = await doFetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      code: a.code,
      state: a.state,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      code_verifier: a.verifier,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token exchange failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new Error(
      "OAuth token exchange returned an incomplete response (missing access_token or refresh_token)",
    );
  }
  // Fall back to 3600 s when expires_in is absent or non-numeric. A short
  // fallback causes an early gateway refresh (harmless — refresh_token is
  // present). An over-long expiry would silently break inference once the
  // access_token actually expires, so erring short is always the safer choice.
  const ttl =
    Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
      ? Number(json.expires_in)
      : 3600;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  };
}

/** Best-effort browser open on macOS. Never throws. */
function defaultOpenUrl(url: string): void {
  try {
    const proc = spawn({ cmd: ["open", url], stdout: "ignore", stderr: "ignore" });
    proc.unref();
  } catch {
    // `open` unavailable (non-macOS, sandbox, etc.) — printing the URL is enough.
  }
}

export interface RunLoginOptions {
  doFetch?: typeof fetch;
  openUrl?: (url: string) => void;
}

/** Interactive paste-back driver. Public signature the provider calls is
 * `runLogin(io)`; `opts` exists only so tests can inject fetch/opener. */
export async function runLogin(io: LoginIO, opts: RunLoginOptions = {}): Promise<OAuthTokens> {
  const doFetch = opts.doFetch ?? fetch;
  const openUrl = opts.openUrl ?? defaultOpenUrl;

  const { verifier, challenge } = buildPkce();
  const state = base64url(randomBytes(16));
  const authorizeUrl = buildAuthorizeUrl({ challenge, state });

  io.writeStdout(
    "To authorize openlock with your Claude subscription, open this URL in your browser:\n\n",
  );
  io.writeStdout(`${authorizeUrl}\n\n`);
  io.writeStdout(
    "After approving, the page shows a code (format: code#state). Copy it and paste it below.\n",
  );
  openUrl(authorizeUrl);

  const pasted = (await io.readLine("Paste the code shown after authorizing:\n> ")).trim();
  if (!pasted) throw new Error("No authorization code entered.");

  const hashIdx = pasted.indexOf("#");
  if (hashIdx === -1) {
    throw new Error(
      "Pasted value is not in the expected `code#state` form — copy the full string the callback page displays.",
    );
  }
  const code = pasted.slice(0, hashIdx).trim();
  const returnedState = pasted.slice(hashIdx + 1).trim();
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch (possible CSRF) — aborting login.");
  }
  if (!code) throw new Error("No authorization code found in pasted value.");

  return exchangeCode({ code, state, verifier }, doFetch);
}
