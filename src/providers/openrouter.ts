import type { Harness } from "../sandbox/harness";
import type { LoginIO, LoginResult, PolicyEndpointSpec, ProviderPlugin } from "./types";

function validateOpenRouterKey(raw: string): string {
  const k = raw.trim();
  if (k === "") throw new Error("OpenRouter API key is empty.");
  if (!k.startsWith("sk-or-")) {
    throw new Error("OpenRouter API key must start with `sk-or-`.");
  }
  if (k.length < 20) {
    throw new Error("OpenRouter API key is too short (need >= 20 chars).");
  }
  return k;
}

export const OPENROUTER: ProviderPlugin = {
  id: "openrouter",
  displayName: "OpenRouter",
  openshellType: "generic",
  credentialEnvVars: ["OPENROUTER_BEARER_TOKEN"],
  // pi (openlock-1ho): OpenRouter-only per the accepted design — openlock
  // already stages OPENROUTER_API_KEY (below), exactly the env var pi reads,
  // at a host (openrouter.ai) the policy already allows. Anthropic does NOT
  // extend to pi: the anthropic plugin stages a Claude-Code-format OAuth
  // credential file, which pi doesn't consume (it wants an x-api-key-style
  // key or its own auth.json) — wiring that would be a provider change, out
  // of scope here.
  compatibleHarnesses: new Set<Harness>(["opencode", "pi"]),

  async loginInteractive(io: LoginIO): Promise<LoginResult> {
    const raw = await io.readLine("Paste your OpenRouter API key (starts with sk-or-):\n> ");
    const key = validateOpenRouterKey(raw);
    return { credentials: { OPENROUTER_BEARER_TOKEN: `Bearer ${key}` } };
  },

  policyEndpoints(harness: Harness): readonly PolicyEndpointSpec[] {
    const openrouterApi: PolicyEndpointSpec = {
      host: "openrouter.ai",
      port: 443,
      protocol: "rest",
      rules: [{ allow: { method: "POST", path: "/api/v1/**" } }],
      cred_inject: {
        provider: "openrouter",
        strip_headers: ["Authorization", "x-api-key", "Cookie"],
        inject: [{ header: "Authorization", from_credential: "OPENROUTER_BEARER_TOKEN" }],
      },
    };
    if (harness !== "opencode") return [openrouterApi];
    return [
      openrouterApi,
      // models.dev is an opencode model-metadata requirement, NOT an OpenRouter
      // API endpoint. opencode resolves model metadata from models.dev; models
      // absent from its bundled registry (cloaked/new models) fail with
      // UnknownError unless this read-only GET egress is allowed. Gated to
      // opencode specifically (openlock-1ho) — pi has its own built-in model
      // catalogs and never touches models.dev, so granting it this egress
      // domain would be an unused, unverified allowance. If a second
      // models.dev-dependent harness is ever added, move this to a
      // harness-level egress source to avoid duplication.
      //
      // opencode's startup @opencode-ai/plugin npm install (registry.npmjs.org)
      // is intentionally NOT allowed — it's non-fatal (opencode runs without the
      // plugin); allowing registry.npmjs.org would widen egress for a
      // non-essential plugin.
      {
        host: "models.dev",
        port: 443,
        protocol: "rest",
        rules: [{ allow: { method: "GET", path: "/**" } }],
        // no cred_inject — public read-only model metadata
      },
      // models.opencode.ai is opencode's OWN model-metadata service, and as of
      // 1.18.18 it is the host opencode actually calls at startup — models.dev
      // is still referenced inside the binary but was not requested even once
      // across two observed runs. Both are allowed rather than swapping one for
      // the other: the strings coexist in the shipped binary, so which one a
      // given release reaches for is opencode's private business, and allowing
      // only the currently-observed host would re-break on any release that
      // falls back.
      //
      // This was found by live verification of the 1.18.9 -> 1.18.18 bump, not
      // by any test: the denial is not fatal-looking from the outside. opencode
      // reports its own opaque `UnknownError` with a server-log reference, the
      // inference request is never attempted, and openrouter.ai appears nowhere
      // in the egress log — so the failure reads as an OpenRouter or credential
      // fault rather than a blocked metadata host. Same class as the models.dev
      // note above; the only new information is the hostname.
      {
        host: "models.opencode.ai",
        port: 443,
        protocol: "rest",
        rules: [{ allow: { method: "GET", path: "/**" } }],
        // no cred_inject — public read-only model metadata
      },
    ];
  },

  sandboxEnvPlaceholders(_harness: Harness): Record<string, string> {
    return { OPENROUTER_API_KEY: "managed-by-openlock-do-not-leak" };
  },

  sandboxFiles: () => [],

  redactionPatterns(): readonly RegExp[] {
    return [/sk-or-v1-[a-zA-Z0-9_-]{20,}/g, /sk-or-[a-zA-Z0-9_-]{20,}/g];
  },
};
