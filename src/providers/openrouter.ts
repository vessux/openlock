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
  openshellType: "openrouter",
  credentialEnvVars: ["OPENROUTER_API_KEY"],
  compatibleHarnesses: new Set<Harness>(["opencode"]),

  async loginInteractive(io: LoginIO): Promise<ProviderCredentials> {
    const raw = await io.readLine("Paste your OpenRouter API key (starts with sk-or-):\n> ");
    const key = validateOpenRouterKey(raw);
    return { OPENROUTER_API_KEY: key };
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
          inject: [{ header: "Authorization", from_credential: "OPENROUTER_API_KEY" }],
        },
      },
    ];
  },

  sandboxEnvPlaceholders(_harness: Harness): Record<string, string> {
    return { OPENROUTER_API_KEY: "managed-by-openlock-do-not-leak" };
  },

  redactionPatterns(): readonly RegExp[] {
    return [/sk-or-v1-[a-zA-Z0-9_-]{20,}/g, /sk-or-[a-zA-Z0-9_-]{20,}/g];
  },
};
