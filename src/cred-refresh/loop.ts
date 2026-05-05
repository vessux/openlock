import { createHash } from "crypto";
import { createSource, type CredentialSource } from "./sources";
import { resolveOpenshellBin, runProviderUpdate, type OpenshellCmd } from "./openshell";
import type { RefreshConfig, ProviderConfig } from "./config";

export function hashCredentials(creds: Record<string, string>): string {
  const keys = Object.keys(creds).sort();
  const hasher = createHash("sha256");
  for (const k of keys) {
    hasher.update(`${k}=${creds[k]}\0`);
  }
  return hasher.digest("hex");
}

export async function resolveProviderCredentials(
  sources: Record<string, CredentialSource>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, source] of Object.entries(sources)) {
    const value = await source.resolve();
    if (value !== null) {
      resolved[key] = value;
    } else {
      console.warn(`[cred-refresh] credential '${key}' resolved to null, skipping`);
    }
  }
  return resolved;
}

interface ProviderState {
  name: string;
  sources: Record<string, CredentialSource>;
  lastHash: string | null;
}

export async function runRefreshLoop(config: RefreshConfig): Promise<never> {
  const cmd = await resolveOpenshellBin();
  console.log(
    `[cred-refresh] using openshell: ${cmd.prefix.length > 0 ? `${cmd.bin} ${cmd.prefix.join(" ")}` : cmd.bin}`,
  );

  const providers: ProviderState[] = config.providers.map((p) => ({
    name: p.name,
    sources: buildSources(p),
    lastHash: null,
  }));

  console.log(
    `[cred-refresh] watching ${providers.length} provider(s), interval=${config.interval_secs}s`,
  );

  while (true) {
    for (const provider of providers) {
      await refreshProvider(cmd, provider);
    }
    await Bun.sleep(config.interval_secs * 1000);
  }
}

function buildSources(provider: ProviderConfig): Record<string, CredentialSource> {
  const sources: Record<string, CredentialSource> = {};
  for (const [key, credConfig] of Object.entries(provider.credentials)) {
    sources[key] = createSource(key, credConfig);
  }
  return sources;
}

async function refreshProvider(cmd: OpenshellCmd, provider: ProviderState): Promise<void> {
  const resolved = await resolveProviderCredentials(provider.sources);
  if (Object.keys(resolved).length === 0) {
    console.warn(`[cred-refresh] provider '${provider.name}': no credentials resolved, skipping`);
    return;
  }

  const hash = hashCredentials(resolved);
  if (hash === provider.lastHash) {
    return;
  }

  const credKeys = Object.keys(resolved).join(", ");
  console.log(`[cred-refresh] provider '${provider.name}': credentials changed (${credKeys}), pushing update`);

  const result = await runProviderUpdate(cmd, provider.name, resolved);
  if (result.ok) {
    provider.lastHash = hash;
    console.log(`[cred-refresh] provider '${provider.name}': update pushed successfully`);
  } else {
    console.error(`[cred-refresh] provider '${provider.name}': update failed: ${result.stderr}`);
  }
}
