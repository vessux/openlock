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

// Staged into CLAUDE_CONFIG_DIR (see container.ts) alongside .credentials.json.
// Skips CC's first-run onboarding flow (theme picker, "Select login method")
// inside the sandbox, which cannot complete a browser login. CC reads
// onboarding/auth state from CLAUDE_CONFIG_DIR when that env var is set
// (container.ts sets it for claude_code), never from $HOME, so this is the
// only copy that takes effect — seed-containerfile.ts used to also bake a
// dead decoy at $HOME/.claude.json; removed in openlock-5wk.
//
// The oauthAccount block is REQUIRED: without it CC does not consider itself
// authenticated even with a valid-shaped .credentials.json present. It is an
// inert placeholder exactly like the OAT/ORT tokens above — no real account
// data ever enters the sandbox. Shape (all-zero/all-one UUIDs, .local email,
// null workspaceRole) is LIVE-VERIFIED against Claude Code 2.1.128 on
// 2026-07-27 against the still-running `authrepro-5edca7` sandbox: CC started
// straight into a prompt and reported Claude Max. Do not hand-wave-edit this
// shape without re-verifying against a real CC startup — an unparseable
// accountUuid/organizationUuid (e.g. non-hex characters in the last UUID
// group) silently regresses to the login selector, and nothing in the test
// suite catches that because the assertion is on our own staged string, not
// on CC's behaviour. This is the shape the version-drift guard should pin to.
const DUMMY_CLAUDE_JSON = JSON.stringify({
  hasCompletedOnboarding: true,
  hasTrustDialogAccepted: true,
  lastOnboardingVersion: "9999.99.99",
  theme: "dark",
  oauthAccount: {
    accountUuid: "00000000-0000-0000-0000-000000000000",
    emailAddress: "sandbox@openlock.local",
    organizationUuid: "00000000-0000-0000-0000-000000000001",
    organizationName: "openlock",
    organizationRole: "admin",
    workspaceRole: null,
  },
  projects: {
    "/sandbox/repo": {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    },
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
    // RAW token stored; gateway adds the "Bearer " prefix at egress. Both
    // endpoints below carry an IDENTICAL cred_inject block deliberately:
    // cred_inject is a per-endpoint field (not inherited across hosts), and
    // CC 2.1.128 makes an unconditional startup connectivity probe to EACH
    // host. Allowing platform.claude.com without its own cred_inject would
    // forward the in-sandbox placeholder token verbatim; upstream then
    // answers 401 "Invalid bearer token" — strictly worse than a blocked
    // connection, since CC treats a 401 as fatal but tolerates a deny.
    const credInject = {
      provider: "anthropic" as const,
      strip_headers: ["Authorization", "x-api-key", "Cookie"],
      inject: [
        {
          header: "Authorization",
          from_credential: "ANTHROPIC_BEARER_TOKEN",
          value_prefix: "Bearer ",
        },
      ],
    };
    return [
      {
        host: "api.anthropic.com",
        port: 443,
        protocol: "rest",
        rules: [
          { allow: { method: "POST", path: "/v1/**" } },
          // CC 2.1.128 unconditional startup connectivity probe. Inside this
          // endpoint block so cred_inject applies to it.
          { allow: { method: "GET", path: "/api/hello" } },
        ],
        cred_inject: credInject,
      },
      // CC 2.1.128 also probes platform.claude.com at startup. Separate host
      // => separate endpoint block => needs its own cred_inject (see comment
      // above).
      {
        host: "platform.claude.com",
        port: 443,
        protocol: "rest",
        rules: [{ allow: { method: "GET", path: "/v1/oauth/hello" } }],
        cred_inject: credInject,
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
      {
        sandboxPath: "/sandbox/.openlock/claude-config/.claude.json",
        content: DUMMY_CLAUDE_JSON,
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
