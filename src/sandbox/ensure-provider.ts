import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import type { ProviderRecord } from "../tokens";
import { readProvider } from "../tokens";
import { buildClaudeOAuthProfileYaml } from "./claude-oauth-profile";
import { getCliInvocation } from "./fork-binaries";

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Shell = (args: string[]) => Promise<ShellResult>;

// Throw-on-nonzero helper for the multi-step refresh-seeding sequence, where a
// per-call custom message isn't worth it (the raw command + stderr is enough to
// diagnose). The generic path keeps its own friendlier inline `Failed to
// create/update provider` throw on purpose — do NOT unify that into mustOk.
/** Run an openshell command, throwing (with stderr) on a non-zero exit. */
async function mustOk(shell: Shell, args: string[]): Promise<ShellResult> {
  const result = await shell(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `openshell ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function realOpenshell(args: string[]): Promise<ShellResult> {
  const cli = await getCliInvocation();
  const proc = Bun.spawn([...cli.argv, ...args], {
    cwd: cli.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// `openshell provider list` prints a space-aligned table:
//   NAME      TYPE     CREDENTIAL_KEYS  CONFIG_KEYS
//   anthropic claude   2                0
//   ...
// (with ANSI bold on the header). Match a line whose first whitespace-
// separated token equals the provider id, after stripping ANSI escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI ESC requires the 0x1b control byte.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function providerExistsInGateway(listStdout: string, providerId: ProviderId): boolean {
  return listStdout
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === providerId);
}

/** Defensive: warn if the plugin's declared openshellType drifts from the
 * stored record. Single code path shared by both the generic and refresh
 * branches so the warning text/condition can't diverge. */
function warnOnTypeDrift(providerId: ProviderId, record: ProviderRecord): void {
  if (PROVIDERS[providerId].openshellType !== record.type) {
    console.warn(
      `openlock: provider '${providerId}' stored type='${record.type}' differs from plugin openshellType='${PROVIDERS[providerId].openshellType}'.`,
    );
  }
}

/**
 * Seed the gateway for a refresh-capable provider (e.g. the Claude OAuth
 * subscription provider).
 *
 * Always imports the runtime profile (idempotent — verified Phase 0.1) so the
 * gateway has token_url + scopes + refresh_before_seconds.
 *
 * NEVER-CLOBBER INVARIANT: `provider create`, `provider update
 * --credential-expires-at`, and `provider refresh configure` run ONLY when the
 * provider is ABSENT (`!exists`). When the provider is already PRESENT the
 * gateway may have refreshed the access token itself; re-pushing the host token
 * would replace that fresh token with the now-stale host one. So on a present
 * provider we do nothing but the idempotent profile import.
 */
async function seedRefreshProvider(
  providerId: ProviderId,
  record: ProviderRecord,
  exists: boolean,
  shell: Shell,
): Promise<void> {
  // record.refresh is non-undefined in this branch (callers gate on it).
  const refresh = record.refresh;
  if (!refresh) {
    throw new Error(`seedRefreshProvider called for '${providerId}' without refresh material`);
  }

  const dir = mkdtempSync(join(tmpdir(), "olk-prof-"));
  try {
    const profPath = join(dir, "claude-oauth.yaml");
    writeFileSync(profPath, buildClaudeOAuthProfileYaml(refresh));
    // `provider profile import` is idempotent, so we run it on every ensure
    // regardless of whether the provider already exists. It awaits via mustOk,
    // so it has fully completed before the finally removes the temp dir.
    await mustOk(shell, ["provider", "profile", "import", "--file", profPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (!exists) {
    const access = record.credentials.ANTHROPIC_BEARER_TOKEN;
    if (!access) {
      throw new Error(
        `Provider '${providerId}' record has refresh material but no ANTHROPIC_BEARER_TOKEN credential; re-run \`openlock login\`.`,
      );
    }
    await mustOk(shell, [
      "provider",
      "create",
      "--name",
      providerId,
      "--type",
      record.type,
      "--credential",
      `ANTHROPIC_BEARER_TOKEN=${access}`,
    ]);
    await mustOk(shell, [
      "provider",
      "update",
      providerId,
      "--credential-expires-at",
      `ANTHROPIC_BEARER_TOKEN=${refresh.access_expires_at}`,
    ]);
    // NOTE: provider NAME is POSITIONAL here (not --name); the CLI strategy
    // token is kebab-case `oauth2-refresh-token` (the stored/profile value is
    // snake `oauth2_refresh_token`); and refresh configure needs its OWN
    // --credential-expires-at to seed the refresh worker's next_refresh.
    await mustOk(shell, [
      "provider",
      "refresh",
      "configure",
      providerId,
      "--credential-key",
      "ANTHROPIC_BEARER_TOKEN",
      "--strategy",
      "oauth2-refresh-token",
      "--material",
      `client_id=${refresh.client_id}`,
      "--material",
      `refresh_token=${refresh.refresh_token}`,
      "--secret-material-key",
      "refresh_token",
      "--credential-expires-at",
      refresh.access_expires_at,
    ]);
  }

  warnOnTypeDrift(providerId, record);
}

export async function ensureProvider(providerId: ProviderId): Promise<void> {
  await _ensureProviderForTests(providerId, realOpenshell);
}

export async function _ensureProviderForTests(providerId: ProviderId, shell: Shell): Promise<void> {
  const record = readProvider(providerId);
  if (!record) {
    throw new Error(
      `No credentials for provider '${providerId}'. Run \`openlock login --provider ${providerId}\` first.`,
    );
  }

  const list = await shell(["provider", "list"]);
  if (list.exitCode !== 0) {
    throw new Error(`Failed to query gateway providers: ${list.stderr || list.stdout}`);
  }
  const exists = providerExistsInGateway(list.stdout, providerId);

  // Gateway-native credential refresh (e.g. the Claude OAuth subscription
  // provider): delegate to seedRefreshProvider, which imports the runtime
  // profile idempotently and seeds create/update/configure ONCE (never
  // re-pushing the host token when the provider already exists).
  if (record.refresh) {
    await seedRefreshProvider(providerId, record, exists, shell);
    return;
  }

  const credArgs = Object.entries(record.credentials).flatMap(([k, v]) => [
    "--credential",
    `${k}=${v}`,
  ]);
  const args = exists
    ? ["provider", "update", providerId, ...credArgs]
    : ["provider", "create", "--name", providerId, "--type", record.type, ...credArgs];

  const result = await shell(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to ${exists ? "update" : "create"} provider '${providerId}' in gateway: ${result.stderr}`,
    );
  }

  warnOnTypeDrift(providerId, record);
}
