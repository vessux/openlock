import type { Harness } from "../sandbox/harness";
import type { LoginIO, LoginResult, PolicyEndpointSpec, ProviderPlugin } from "./types";

function validateCopilotPat(raw: string): string {
  const token = raw.trim();
  if (token === "") throw new Error("GitHub Copilot PAT is empty.");
  if (!token.startsWith("github_pat_")) {
    throw new Error(
      "GitHub Copilot requires a user-owned FINE-GRAINED personal access token " +
        "(github_pat_...) with the 'Copilot Requests' permission — classic PATs " +
        "(ghp_/gho_) are not supported, even for business/enterprise plans.",
    );
  }
  return token;
}

export const GITHUB_COPILOT: ProviderPlugin = {
  id: "github_copilot",
  displayName: "GitHub Copilot",
  openshellType: "generic",
  credentialEnvVars: ["GITHUB_COPILOT_PAT"],
  // copilot_cli ONLY (openlock-ag09 Route A). Copilot-on-opencode/pi is
  // openlock-hqiu's job as a generic-OpenAI-compatible preset; adding it here
  // would silently widen those harnesses' policy blocks (render:policies
  // UNIONS every compatible provider's policyEndpoints per harness).
  compatibleHarnesses: new Set<Harness>(["copilot_cli"]),

  async loginInteractive(io: LoginIO): Promise<LoginResult> {
    const raw = await io.readLine(
      "Paste your GitHub Copilot fine-grained personal access token (github_pat_...):\n> ",
    );
    const token = validateCopilotPat(raw);
    return { credentials: { GITHUB_COPILOT_PAT: token } };
  },

  policyEndpoints(_harness: Harness): readonly PolicyEndpointSpec[] {
    // RAW token stored; gateway adds "Bearer " via value_prefix at egress
    // (live-verified 2026-09-08 — the CLI sends the PAT directly to both
    // api.github.com and the inference host).
    const credInject = {
      provider: "github_copilot" as const,
      strip_headers: ["Authorization", "x-api-key", "Cookie"],
      inject: [
        {
          header: "Authorization",
          from_credential: "GITHUB_COPILOT_PAT",
          value_prefix: "Bearer ",
        },
      ],
    };
    // Copilot's inference host is per-account (individual/business/enterprise),
    // but the set is small and fixed, so all three are hardcoded here — same
    // posture as ANTHROPIC hardcoding api.anthropic.com. GHEC data residency
    // (*.ghe.com) is out of scope.
    const inferenceHosts = [
      "api.individual.githubcopilot.com",
      "api.business.githubcopilot.com",
      "api.enterprise.githubcopilot.com",
    ];
    return [
      {
        // Live-captured 2026-09-08: the CLI itself calls copilot_internal/user
        // and copilot_internal/managed_settings at startup.
        host: "api.github.com",
        port: 443,
        protocol: "rest",
        rules: [
          { allow: { method: "GET", path: "/copilot_internal/user" } },
          { allow: { method: "GET", path: "/copilot_internal/managed_settings" } },
        ],
        cred_inject: credInject,
      },
      ...inferenceHosts.map(
        (host): PolicyEndpointSpec => ({
          host,
          port: 443,
          protocol: "rest",
          rules: [
            // Live-captured 2026-09-08 (copilot 1.0.83): GET /models -> POST
            // /auto -> POST /models/session -> POST /models/session/intent ->
            // POST /v1/messages (Claude models) or /responses (GPT models),
            // plus /mcp/readonly. Denying any of these surfaces in the CLI as
            // an opaque "Authorization error", not a clear policy-deny.
            { allow: { method: "GET", path: "/models" } },
            { allow: { method: "POST", path: "/models/session" } },
            { allow: { method: "POST", path: "/chat/completions" } },
            { allow: { method: "POST", path: "/responses" } },
            { allow: { method: "POST", path: "/models/session/intent" } },
            { allow: { method: "POST", path: "/v1/messages" } },
            { allow: { method: "POST", path: "/mcp/readonly" } },
            { allow: { method: "POST", path: "/auto" } },
          ],
          cred_inject: credInject,
        }),
      ),
      // telemetry.<plan>.githubcopilot.com is deliberately ABSENT — no auth
      // header on that path, and default-deny is the right posture for a
      // non-essential sink (live-verified harmless when denied).
    ];
  },

  sandboxEnvPlaceholders(_harness: Harness): Record<string, string> {
    // COPILOT_GITHUB_TOKEN specifically: the CLI's own env precedence is
    // COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN > OS keychain > gh CLI,
    // so this is the only name a stray GH_TOKEN/GITHUB_TOKEN can't shadow.
    // Token-shaped on purpose (live-verified 2026-09-08): the CLI rejects a
    // non-token-shaped value locally ("No authentication information found")
    // before ever touching the network.
    return {
      COPILOT_GITHUB_TOKEN:
        "github_pat_managed_by_openlock_do_not_leak_0000000000000000000000000000000000000000000000000000000000000000000",
    };
  },

  sandboxFiles: () => [],

  redactionPatterns(): readonly RegExp[] {
    return [/github_pat_[A-Za-z0-9_]{20,}/g, /gh[opus]_[A-Za-z0-9]{20,}/g];
  },
};
