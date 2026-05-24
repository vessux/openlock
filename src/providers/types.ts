import type { Harness } from "../sandbox/harness";

export type ProviderId = "anthropic" | "openrouter";
export type OpenshellProviderType = "claude" | "openrouter";

export interface ProviderCredentials {
  [envName: string]: string;
}

export interface LoginIO {
  readLine(prompt: string): Promise<string>;
  writeStdout(s: string): void;
  writeStderr(s: string): void;
  readonly isTTY: boolean;
}

export interface CredInjectSpec {
  provider: ProviderId;
  strip_headers: readonly string[];
  inject: ReadonlyArray<{ header: string; from_credential: string }>;
}

export interface PolicyEndpointSpec {
  host: string;
  port: number;
  protocol: "rest";
  rules: ReadonlyArray<{ allow: { method: string; path: string } }>;
  cred_inject: CredInjectSpec;
}

export interface ProviderPlugin {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly openshellType: OpenshellProviderType;
  readonly credentialEnvVars: readonly string[];
  readonly compatibleHarnesses: ReadonlySet<Harness>;
  loginInteractive(io: LoginIO): Promise<ProviderCredentials>;
  policyEndpoints(harness: Harness): readonly PolicyEndpointSpec[];
  sandboxEnvPlaceholders(harness: Harness): Record<string, string>;
  redactionPatterns(): readonly RegExp[];
}
