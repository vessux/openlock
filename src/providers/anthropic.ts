import type { Harness } from "../sandbox/harness";
import { importFromClaudeCode, realImportDeps } from "./anthropic-import";
import type {
  LoginIO,
  LoginResult,
  PolicyEndpointSpec,
  ProviderPlugin,
  SandboxFile,
} from "./types";

// Dummy OAuth-shaped credentials staged into the sandbox at
// /sandbox/.openlock/claude-config/.credentials.json. Its only job is to flip
// Claude Code into OAuth (subscription) mode — it NEVER authenticates. The
// gateway proxy strips the placeholder Authorization header and injects the
// real subscription access token at egress, so the real token never enters the
// sandbox. The OAT/ORT-shaped values are inert placeholders.
const DUMMY_CREDENTIALS_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-openlock-placeholder-000000000000000000000000000000",
    refreshToken: "sk-ant-ort01-openlock-placeholder-000000000000000000000000000000",
    expiresAt: 4102444800000, // ~year 2100 in epoch-ms — Claude Code never treats this as expired
    scopes: ["user:inference"], // inert placeholder; real scopes/subscriptionType are enforced gateway-side
    subscriptionType: "max",
  },
});

export const ANTHROPIC: ProviderPlugin = {
  id: "anthropic",
  displayName: "Anthropic (Claude subscription)",
  openshellType: "claude-oauth",
  credentialEnvVars: ["ANTHROPIC_BEARER_TOKEN"],
  // claude_code ONLY. The subscription OAuth flow flips Claude Code into OAuth
  // mode via a staged .credentials.json; opencode has no such mechanism. Use
  // OpenRouter (or the OpenCode Claude-auth plugin) with opencode instead.
  compatibleHarnesses: new Set<Harness>(["claude_code"]),

  async loginInteractive(io: LoginIO): Promise<LoginResult> {
    // Import the subscription token from an isolated Claude Code login rather
    // than reimplementing Claude's OAuth handshake (which proved fragile across
    // endpoint/scope changes). Claude Code's login is always-correct by
    // construction; the harvested raw token carries NO "Bearer " prefix — the
    // gateway prepends it via the policy cred_inject value_prefix at egress.
    return importFromClaudeCode(io, realImportDeps());
  },

  policyEndpoints(_harness: Harness): readonly PolicyEndpointSpec[] {
    return [
      {
        host: "api.anthropic.com",
        port: 443,
        protocol: "rest",
        rules: [{ allow: { method: "POST", path: "/v1/**" } }],
        cred_inject: {
          provider: "anthropic",
          strip_headers: ["Authorization", "x-api-key", "Cookie"],
          // RAW token stored; gateway adds the "Bearer " prefix at egress.
          inject: [
            {
              header: "Authorization",
              from_credential: "ANTHROPIC_BEARER_TOKEN",
              value_prefix: "Bearer ",
            },
          ],
        },
      },
    ];
  },

  // OAuth-file flow: Claude Code reads the staged .credentials.json, so no env
  // placeholder is needed.
  sandboxEnvPlaceholders(_harness: Harness): Record<string, string> {
    return {};
  },

  sandboxFiles(harness: Harness): readonly SandboxFile[] {
    if (harness !== "claude_code") return [];
    return [
      {
        sandboxPath: "/sandbox/.openlock/claude-config/.credentials.json",
        content: DUMMY_CREDENTIALS_JSON,
      },
    ];
  },

  redactionPatterns(): readonly RegExp[] {
    return [
      /sk-ant-oat[0-9]{2}-[a-zA-Z0-9_-]{20,}/g,
      /sk-ant-ort[0-9]{2}-[a-zA-Z0-9_-]{20,}/g,
      /Bearer\s+sk-ant-[a-zA-Z0-9_-]{20,}/gi,
      /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    ];
  },
};
