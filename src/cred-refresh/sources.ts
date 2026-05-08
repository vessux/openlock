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

export function createSource(
  credentialKey: string,
  config: { source: string; env_var?: string },
): CredentialSource {
  switch (config.source) {
    case "env":
      return new EnvSource(credentialKey, config.env_var);
    default:
      throw new Error(
        `Unknown credential source type '${config.source}' for key '${credentialKey}'. Supported: env`,
      );
  }
}
