import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigDir } from "./paths";
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
  return join(resolveConfigDir(), "credentials.json");
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
//
// openlock-cjr: this used to truncate the V1 file with no backup and no
// notice — a getter-shaped function (readCredentials, called even by purely
// informational reads like `openlock doctor`) silently destroying credential
// material. We chose (a) back-up-then-warn over (b) leave-untouched: (b)
// re-detects V1 on EVERY future read forever (nothing on disk ever changes),
// so a one-time warning would need separate persisted state anyway — which is
// itself a mutation, defeating the "don't mutate in the getter" motivation for
// (b) in the first place. (a) already mutates once (bumping to V2, as before)
// so the migration is naturally one-time: once the file reads as V2,
// isLegacyV1 is false on every later read, in this or any later process.
function backupPathFor(path: string): string {
  return `${path}.v1.bak`;
}

/** Preserve the original V1 bytes before the destructive write, and verify the
 * backup landed correctly BEFORE touching the original — never truncate on
 * the strength of an unverified backup. Throws (aborting the migration, the
 * original file left untouched) if the backup can't be written or doesn't
 * read back identically — e.g. disk full — rather than proceeding anyway. */
function backupLegacyFile(path: string, raw: string): void {
  const backup = backupPathFor(path);
  writeFileSync(backup, raw, { mode: 0o600 });
  const verify = readFileSync(backup, "utf-8");
  if (verify !== raw) {
    throw new Error(
      `openlock: could not verify the legacy credentials backup at ${backup} — aborting the ` +
        `migration to avoid losing data. ${path} was left untouched.`,
    );
  }
}

function migrateLegacyV1(path: string, raw: string): CredentialsFileV2 {
  backupLegacyFile(path, raw);
  const migrated = emptyFile();
  writeAtomic(path, migrated);
  console.warn(
    `openlock: found a legacy v1 credentials file at ${path}. Its setup-token bearer can't be ` +
      `used in the current OAuth-subscription mode, so it has been cleared; your original file ` +
      `was preserved at ${backupPathFor(path)}. Run \`openlock login\` to set up credentials again.`,
  );
  return migrated;
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
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return emptyFile();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFile();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyFile();
  }
  const obj = parsed as Record<string, unknown>;
  if (isLegacyV1(obj)) {
    return migrateLegacyV1(p, raw);
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
