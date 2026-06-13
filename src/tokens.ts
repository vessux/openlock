import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId } from "./providers/types";

/** Gateway-side credential-refresh material captured HOST-side at login. Lets
 * the gateway mint a fresh access token from the refresh token without a new
 * interactive login. Never enters the sandbox. */
export interface ProviderRefreshMaterial {
  strategy: "oauth2_refresh_token";
  token_url: string;
  scopes: string[];
  client_id: string;
  refresh_token: string;
  access_expires_at: string; // RFC3339, seeds gateway credential expiry
}

export interface ProviderRecord {
  type: string;
  credentials: Record<string, string>;
  created_at: string;
  refresh?: ProviderRefreshMaterial;
}

export interface CredentialsFileV2 {
  version: 2;
  providers: Partial<Record<ProviderId, ProviderRecord>>;
}

export function credentialsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(process.env.HOME ?? homedir(), ".config");
  return join(base, "openlock", "credentials.json");
}

function emptyFile(): CredentialsFileV2 {
  return { version: 2, providers: {} };
}

function isLegacyV1(obj: Record<string, unknown>): obj is { token: string; created_at?: string } {
  return typeof obj.token === "string" && obj.version === undefined;
}

// The legacy V1 file held a single long-lived `setup-token` bearer (the old
// API/inference auth mode). The anthropic provider is now OAuth-subscription:
// it stores a RAW access token (the gateway adds "Bearer " via value_prefix)
// plus refresh material that a V1 token simply does not have. Carrying the V1
// token forward would produce a double-prefixed, unrefreshable, wrong-mode
// credential — so we drop it and surface an empty file, prompting a fresh
// `openlock login` through the new OAuth flow. We still bump the file to V2 on
// disk so the stale single-token shape stops being re-parsed every read.
function migrateV1(_legacy: { token: string; created_at?: string }): CredentialsFileV2 {
  return emptyFile();
}

function writeAtomic(path: string, data: CredentialsFileV2): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readCredentials(path?: string): CredentialsFileV2 {
  const p = path ?? credentialsPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return emptyFile();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyFile();
  }
  const obj = parsed as Record<string, unknown>;
  if (isLegacyV1(obj)) {
    const migrated = migrateV1(obj as { token: string; created_at?: string });
    writeAtomic(p, migrated);
    return migrated;
  }
  if (obj.version !== 2 || typeof obj.providers !== "object" || obj.providers === null) {
    return emptyFile();
  }
  return { version: 2, providers: obj.providers as CredentialsFileV2["providers"] };
}

export function readProvider(id: ProviderId, path?: string): ProviderRecord | null {
  const file = readCredentials(path);
  return file.providers[id] ?? null;
}

export function writeProvider(id: ProviderId, record: ProviderRecord, path?: string): void {
  const p = path ?? credentialsPath();
  const file = readCredentials(p);
  file.providers[id] = record;
  writeAtomic(p, file);
}

export function deleteProvider(id: ProviderId, path?: string): void {
  const p = path ?? credentialsPath();
  const file = readCredentials(p);
  delete file.providers[id];
  writeAtomic(p, file);
}

export function hasAnyProvider(path?: string): boolean {
  return Object.keys(readCredentials(path).providers).length > 0;
}
