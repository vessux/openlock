import { readFileSync } from "node:fs";
import yaml from "js-yaml";

interface CredentialConfig {
  source: string;
  env_var?: string;
}

export interface ProviderConfig {
  name: string;
  type: string;
  credentials: Record<string, CredentialConfig>;
}

export interface RefreshConfig {
  endpoint?: string;
  interval_secs: number;
  providers: ProviderConfig[];
}

export function loadConfig(path: string): RefreshConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`Config file not found: ${path}`);
  }

  const doc = yaml.load(raw) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid config: expected YAML object in ${path}`);
  }

  const providers = doc.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error(`Config must define at least one provider in ${path}`);
  }

  for (const p of providers) {
    if (!p.name || typeof p.name !== "string") {
      throw new Error(`Each provider must have a 'name' field in ${path}`);
    }
    if (
      !p.credentials ||
      typeof p.credentials !== "object" ||
      Object.keys(p.credentials).length === 0
    ) {
      throw new Error(`Provider '${p.name}' must have non-empty 'credentials' in ${path}`);
    }
  }

  return {
    endpoint: typeof doc.endpoint === "string" ? doc.endpoint : undefined,
    interval_secs: typeof doc.interval_secs === "number" ? doc.interval_secs : 60,
    providers: providers as ProviderConfig[],
  };
}

export function resolveEndpoint(configEndpoint?: string): string {
  return configEndpoint ?? process.env.OPENSHELL_ENDPOINT ?? "localhost:9090";
}
