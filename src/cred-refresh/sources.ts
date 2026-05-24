import type { ProviderId } from "../providers/types";
import { readProvider } from "../tokens";

export interface CredentialSource {
  readonly type: string;
  resolve(): Promise<string | null>;
}

export class EnvSource implements CredentialSource {
  readonly type = "env" as const;
  readonly envVar: string;

  constructor(credentialKey: string, envVar?: string) {
    this.envVar = envVar ?? credentialKey;
  }

  async resolve(): Promise<string | null> {
    const value = process.env[this.envVar];
    if (value === undefined || value === "") return null;
    return value;
  }
}

export class FileSource implements CredentialSource {
  readonly type = "file" as const;
  readonly providerId: ProviderId;
  readonly envName: string;

  constructor(credentialKey: string, opts: { providerId: ProviderId; envName?: string }) {
    this.envName = opts.envName ?? credentialKey;
    this.providerId = opts.providerId;
  }

  async resolve(): Promise<string | null> {
    const record = readProvider(this.providerId);
    if (!record) return null;
    const value = record.credentials[this.envName];
    return value === undefined || value === "" ? null : value;
  }
}

export function createSource(
  credentialKey: string,
  config: { source: string; env_var?: string; provider_id?: string },
): CredentialSource {
  switch (config.source) {
    case "env":
      return new EnvSource(credentialKey, config.env_var);
    case "file":
      if (!config.provider_id) {
        throw new Error(
          `Credential '${credentialKey}' with source: file must specify provider_id.`,
        );
      }
      return new FileSource(credentialKey, {
        providerId: config.provider_id as ProviderId,
      });
    default:
      throw new Error(
        `Unknown credential source type '${config.source}' for key '${credentialKey}'. Supported: env, file`,
      );
  }
}
