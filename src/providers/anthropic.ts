import { spawn } from "bun";
import type { Harness } from "../sandbox/harness";
import type { LoginIO, PolicyEndpointSpec, ProviderCredentials, ProviderPlugin } from "./types";

async function runClaudeSetupToken(io: LoginIO): Promise<string> {
  io.writeStdout("Running `claude setup-token` to generate a long-lived OAuth token...\n");
  const proc = spawn({
    cmd: ["claude", "setup-token"],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error("`claude setup-token` exited non-zero. Aborting login.");
  }
  return (await io.readLine("\nPaste the token printed above:\n> ")).trim();
}

export const ANTHROPIC: ProviderPlugin = {
  id: "anthropic",
  displayName: "Anthropic (Claude)",
  openshellType: "claude",
  credentialEnvVars: ["ANTHROPIC_BEARER_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  compatibleHarnesses: new Set<Harness>(["claude_code", "opencode"]),

  async loginInteractive(io: LoginIO): Promise<ProviderCredentials> {
    const token = await runClaudeSetupToken(io);
    if (!token) throw new Error("No token entered.");
    return {
      ANTHROPIC_BEARER_TOKEN: `Bearer ${token}`,
      ANTHROPIC_AUTH_TOKEN: token,
    };
  },

  policyEndpoints(harness: Harness): readonly PolicyEndpointSpec[] {
    const base = {
      host: "api.anthropic.com",
      port: 443,
      protocol: "rest" as const,
      rules: [{ allow: { method: "POST", path: "/v1/**" } }],
    };
    if (harness === "claude_code") {
      return [
        {
          ...base,
          cred_inject: {
            provider: "anthropic",
            strip_headers: ["Authorization", "x-api-key", "Cookie"],
            inject: [{ header: "Authorization", from_credential: "ANTHROPIC_BEARER_TOKEN" }],
          },
        },
      ];
    }
    // opencode and future providers share the API-key path
    return [
      {
        ...base,
        cred_inject: {
          provider: "anthropic",
          strip_headers: ["Authorization", "x-api-key", "Cookie"],
          inject: [{ header: "x-api-key", from_credential: "ANTHROPIC_API_KEY" }],
        },
      },
    ];
  },

  sandboxEnvPlaceholders(harness: Harness): Record<string, string> {
    if (harness === "claude_code") return {};
    return { ANTHROPIC_API_KEY: "managed-by-openlock-do-not-leak" };
  },

  // TEMPORARY: real impl (dummy OAuth-shaped .credentials.json that flips
  // Claude Code into OAuth mode) lands in Phase 5. See bd openlock-ndb.
  sandboxFiles: () => [],

  redactionPatterns(): readonly RegExp[] {
    return [
      /sk-ant-oat[0-9]{2}-[a-zA-Z0-9_-]{20,}/g,
      /sk-ant-[a-zA-Z0-9_-]{20,}/g,
      /Bearer\s+sk-ant-[a-zA-Z0-9_-]{20,}/gi,
    ];
  },
};
