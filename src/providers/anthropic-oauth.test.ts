import { describe, expect, it } from "bun:test";
import {
  buildAuthorizeUrl,
  buildPkce,
  CLAUDE_OAUTH_SCOPES,
  exchangeCode,
  type OAuthTokens,
  runLogin,
} from "./anthropic-oauth";
import type { LoginIO } from "./types";

const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A LoginIO whose readLine returns whatever `reply(printed)` computes from the
 * concatenated stdout written so far. Lets a test echo back the state it sees
 * in the printed authorize URL, enabling a deterministic happy path. */
function makeIO(reply: (printed: string) => string): {
  io: LoginIO;
  stdout: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: LoginIO = {
    readLine: async () => reply(out.join("")),
    writeStdout: (s) => out.push(s),
    writeStderr: (s) => err.push(s),
    isTTY: false,
  };
  return { io, stdout: () => out.join("") + err.join("") };
}

/** Pull the `state` query param out of a printed authorize URL. */
function extractState(printed: string): string {
  const match = printed.match(/https:\/\/\S+/);
  if (!match) throw new Error("no URL printed");
  const url = new URL(match[0]);
  const state = url.searchParams.get("state");
  if (!state) throw new Error("no state in printed URL");
  return state;
}

describe("buildPkce", () => {
  it("produces a base64url verifier of length >= 43", () => {
    const { verifier } = buildPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(BASE64URL);
    expect(verifier).not.toContain("=");
  });

  it("produces an S256 challenge that is base64url and differs from the verifier", () => {
    const { verifier, challenge } = buildPkce();
    expect(challenge).toMatch(BASE64URL);
    expect(challenge).not.toContain("=");
    expect(challenge).not.toBe(verifier);
  });

  it("produces unique verifiers across calls", () => {
    expect(buildPkce().verifier).not.toBe(buildPkce().verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("emits the expected PKCE / hosted-callback query params", () => {
    const url = new URL(buildAuthorizeUrl({ challenge: "CHALLENGE", state: "STATE" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBeTruthy();
    expect(p.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(p.get("scope")).toBe(CLAUDE_OAUTH_SCOPES.join(" "));
    expect(p.get("code_challenge")).toBe("CHALLENGE");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("STATE");
    // hosted-callback display flow
    expect(p.get("code")).toBe("true");
  });
});

describe("exchangeCode", () => {
  it("POSTs a JSON authorization_code body and maps the token response", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-A",
          refresh_token: "sk-ant-ort01-R",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tokens = await exchangeCode(
      { code: "THECODE", state: "THESTATE", verifier: "THEVERIFIER" },
      fakeFetch,
    );

    expect(captured).toBeDefined();
    expect(captured?.url).toBe("https://platform.claude.com/v1/oauth/token");
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("content-type")).toContain("application/json");
    expect(headers.get("accept")).toContain("application/json");

    const body = JSON.parse(String(captured?.init.body));
    expect(body.grant_type).toBe("authorization_code");
    expect(body.client_id).toBeTruthy();
    expect(body.code).toBe("THECODE");
    expect(body.state).toBe("THESTATE");
    expect(body.code_verifier).toBe("THEVERIFIER");
    expect(body.redirect_uri).toBe(REDIRECT_URI);

    const t: OAuthTokens = tokens;
    expect(t.access_token).toBe("sk-ant-oat01-A");
    expect(t.refresh_token).toBe("sk-ant-ort01-R");
    expect(t.client_id).toBeTruthy();
    expect(typeof t.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(t.expires_at))).toBe(false);
  });

  it("throws including status and body on non-OK", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode({ code: "c", state: "s", verifier: "v" }, fakeFetch)).rejects.toThrow(
      /400/,
    );
  });

  it("resolves with a valid expires_at when expires_in is absent", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "sk-ant-oat01-A", refresh_token: "sk-ant-ort01-R" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const r = await exchangeCode({ code: "c", state: "s", verifier: "v" }, fakeFetch);
    expect(typeof r.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(r.expires_at))).toBe(false);
  });

  it("rejects when access_token is absent", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ refresh_token: "sk-ant-ort01-R", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(exchangeCode({ code: "c", state: "s", verifier: "v" }, fakeFetch)).rejects.toThrow(
      /missing access_token or refresh_token/,
    );
  });
});

describe("runLogin", () => {
  const noopOpener = () => {};

  it("rejects when the pasted state does not match the generated state (CSRF)", async () => {
    const { io } = makeIO(() => "SOMECODE#WRONGSTATE");
    const fakeFetch = (async () => {
      throw new Error("must not reach token exchange on state mismatch");
    }) as unknown as typeof fetch;
    await expect(runLogin(io, { doFetch: fakeFetch, openUrl: noopOpener })).rejects.toThrow(
      /state/i,
    );
  });

  it("happy path: echoes the printed state back and returns mapped tokens", async () => {
    let exchanged: Record<string, string> | undefined;
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      exchanged = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-OK",
          refresh_token: "sk-ant-ort01-OK",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    // The stub reads the state out of the printed authorize URL and pastes
    // back `code#state` so the CSRF check passes deterministically.
    const { io } = makeIO((printed) => `THECODE#${extractState(printed)}`);

    const tokens = await runLogin(io, { doFetch: fakeFetch, openUrl: noopOpener });

    expect(tokens.access_token).toBe("sk-ant-oat01-OK");
    expect(tokens.refresh_token).toBe("sk-ant-ort01-OK");
    expect(exchanged?.code).toBe("THECODE");
    expect(exchanged?.grant_type).toBe("authorization_code");
    // verifier sent to the token endpoint is the one minted internally
    expect(exchanged?.code_verifier).toBeTruthy();
  });
});
