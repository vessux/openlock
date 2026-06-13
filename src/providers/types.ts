import type { Harness } from "../sandbox/harness";
import type { ProviderRefreshMaterial } from "../tokens";

export type ProviderId = "anthropic" | "openrouter";
type OpenshellProviderType = "claude" | "claude-oauth" | "generic";

export interface ProviderCredentials {
  [envName: string]: string;
}

/** Outcome of an interactive login: the credentials to store plus optional
 * gateway-side refresh material (for OAuth providers whose access token expires
 * and must be refreshed without a new interactive login). */
export interface LoginResult {
  credentials: ProviderCredentials;
  refresh?: ProviderRefreshMaterial;
}

export interface LoginIO {
  readLine(prompt: string): Promise<string>;
  writeStdout(s: string): void;
  writeStderr(s: string): void;
  readonly isTTY: boolean;
}

interface CredInjectSpec {
  provider: ProviderId;
  strip_headers: readonly string[];
  inject: ReadonlyArray<{ header: string; from_credential: string; value_prefix?: string }>;
}

export interface SandboxFile {
  /** Absolute sandbox path under /sandbox/.openlock/. */
  sandboxPath: string;
  content: string;
}

export interface PolicyEndpointSpec {
  host: string;
  port: number;
  protocol: "rest";
  rules: ReadonlyArray<{ allow: { method: string; path: string } }>;
  /** Optional: endpoints carrying no credential (e.g. public read-only
   * metadata like models.dev) omit this and render as a plain allow-egress rule. */
  cred_inject?: CredInjectSpec;
}

/** Contract every openlock credential provider implements. */
export interface ProviderPlugin {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly openshellType: OpenshellProviderType;
  /** Env-var names under which credentials are stored in the openlock credentials file. These are not necessarily the env vars injected into the sandbox. */
  readonly credentialEnvVars: readonly string[];
  readonly compatibleHarnesses: ReadonlySet<Harness>;
  loginInteractive(io: LoginIO): Promise<LoginResult>;
  policyEndpoints(harness: Harness): readonly PolicyEndpointSpec[];
  /** Returns placeholder strings, not real credential values — the real credential never enters the sandbox. The gateway strip-replaces placeholders with real values at HTTP egress. */
  sandboxEnvPlaceholders(harness: Harness): Record<string, string>;
  /** Files staged into the sandbox under /sandbox/.openlock/. These carry no
   * real secrets — placeholders the gateway swaps at egress (e.g. a dummy
   * OAuth-shaped .credentials.json that flips Claude Code into OAuth mode). */
  sandboxFiles(harness: Harness): readonly SandboxFile[];
  redactionPatterns(): readonly RegExp[];
}
