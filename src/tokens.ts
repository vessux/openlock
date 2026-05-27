import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId } from "./providers/types";

export interface ProviderRecord {
  type: string;
  credentials: Record<string, string>;
  created_at: string;
}

export interface CredentialsFileV2 {
  version: 2;
  providers: Partial<Record<ProviderId, ProviderRecord>>;
}

export function credentialsPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".config", "openlock", "credentials.json");
}

function emptyFile(): CredentialsFileV2 {
  return { version: 2, providers: {} };
}

function isLegacyV1(obj: Record<string, unknown>): obj is { token: string; created_at?: string } {
  return typeof obj.token === "string" && obj.version === undefined;
}

function migrateV1(legacy: { token: string; created_at?: string }): CredentialsFileV2 {
  return {
    version: 2,
    providers: {
      anthropic: {
        type: "claude",
        credentials: {
          ANTHROPIC_BEARER_TOKEN: `Bearer ${legacy.token}`,
          ANTHROPIC_AUTH_TOKEN: legacy.token,
        },
        created_at: legacy.created_at ?? new Date().toISOString(),
      },
    },
  };
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
