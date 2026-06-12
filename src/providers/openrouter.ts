import type { Harness } from "../sandbox/harness";
import type { LoginIO, PolicyEndpointSpec, ProviderCredentials, ProviderPlugin } from "./types";

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
  compatibleHarnesses: new Set<Harness>(["opencode"]),

  async loginInteractive(io: LoginIO): Promise<ProviderCredentials> {
    const raw = await io.readLine("Paste your OpenRouter API key (starts with sk-or-):\n> ");
    const key = validateOpenRouterKey(raw);
    return { OPENROUTER_BEARER_TOKEN: `Bearer ${key}` };
  },

  policyEndpoints(_harness: Harness): readonly PolicyEndpointSpec[] {
    return [
      {
        host: "openrouter.ai",
        port: 443,
        protocol: "rest",
        rules: [{ allow: { method: "POST", path: "/api/v1/**" } }],
        cred_inject: {
          provider: "openrouter",
          strip_headers: ["Authorization", "x-api-key", "Cookie"],
          inject: [{ header: "Authorization", from_credential: "OPENROUTER_BEARER_TOKEN" }],
        },
      },
      // models.dev is an opencode model-metadata requirement, NOT an OpenRouter
      // API endpoint. opencode resolves model metadata from models.dev; models
      // absent from its bundled registry (cloaked/new models) fail with
      // UnknownError unless this read-only GET egress is allowed. opencode is
      // currently the only openrouter-compatible harness so this is emitted
      // unconditionally; if a second opencode-compatible provider is ever added,
      // move this to a harness-level egress source to avoid duplication.
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
