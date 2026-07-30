import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import type { ProviderRecord } from "../tokens";
import { readProvider } from "../tokens";
import { buildClaudeOAuthProfileYaml, CLAUDE_OAUTH_PROFILE_ID } from "./claude-oauth-profile";
import { getCliInvocation, openshellCommandHint } from "./fork-binaries";

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Shell = (args: string[], env?: Record<string, string>) => Promise<ShellResult>;

// Throw-on-nonzero helper for the multi-step refresh-seeding sequence, where a
// per-call custom message isn't worth it (the raw command + stderr is enough to
// diagnose). The generic path keeps its own friendlier inline `Failed to
// create/update provider` throw on purpose — do NOT unify that into mustOk.
/** Run an openshell command, throwing (with stderr) on a non-zero exit. */
async function mustOk(
  shell: Shell,
  args: string[],
  env?: Record<string, string>,
): Promise<ShellResult> {
  const result = await shell(args, env);
  if (result.exitCode !== 0) {
    throw new Error(
      `openshell ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function realOpenshell(args: string[], env?: Record<string, string>): Promise<ShellResult> {
  const cli = await getCliInvocation();
  const proc = Bun.spawn([...cli.argv, ...args], {
    cwd: cli.cwd,
    // Credential values are passed through the child's env (see
    // credentialArgsAndEnv), not argv, so they never land in the
    // world-readable /proc/<pid>/cmdline.
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

/**
 * Build `--credential KEY` args (no inline value) plus the env map the spawned
 * openshell resolves them from. The fork reads a bare `--credential KEY` from
 * `std::env::var(KEY)` (see parse_credential_pairs in openshell-cli), so passing
 * secrets this way keeps them out of argv — process arguments are visible to any
 * local user via `ps`/`/proc/<pid>/cmdline`, whereas `/proc/<pid>/environ` is
 * readable only by the same uid. Credential keys are env-var names by
 * construction (e.g. ANTHROPIC_BEARER_TOKEN, generic secondary-cred keys).
 */
function credentialArgsAndEnv(credentials: Record<string, string>): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    args.push("--credential", key);
    env[key] = value;
  }
  return { args, env };
}

// `openshell provider list` prints a space-aligned table:
//   NAME      TYPE     CREDENTIAL_KEYS  CONFIG_KEYS
//   anthropic claude   2                0
//   ...
// (with ANSI bold on the header). Match a line whose first whitespace-
// separated token equals the provider id, after stripping ANSI escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI ESC requires the 0x1b control byte.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function providerExistsInGateway(listStdout: string, providerId: string): boolean {
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

// ---------------------------------------------------------------------------
// Gateway credential health (openlock-7mh / openlock-stj)
//
// The gateway silently skips an expired provider credential and hands the
// sandbox ZERO credentials while its own RPC still reports success (WARN
// `skipping expired provider credential`, then `status=200`). cred_inject then
// strips Authorization and injects nothing, so in-sandbox CC sees a 401 /
// ECONNRESET / misleading connectivity error with no trace beyond a WARN
// buried in gateway.log. The functions below mirror the gateway's OWN skip
// check (openshell-server/src/grpc/provider.rs: `credential_expires_at_ms[key]
// > 0 && <= now`) from the openlock side, using the SAME field the gateway
// itself reads (`provider list --output json` -> `credential_expires_at_ms`),
// so this is a faithful shadow of gateway behavior, not a heuristic.
// ---------------------------------------------------------------------------

interface GatewayProviderJson {
  name?: unknown;
  credential_expires_at_ms?: unknown;
}

/** Fetch `openshell provider list --output json` and parse it. Returns null on
 * ANY failure (transport error, non-JSON output, non-array shape) — this is an
 * advisory read on top of the core create/update flow, so a parsing hiccup
 * degrades to "can't determine" rather than breaking sandbox creation. */
async function fetchGatewayProviderList(shell: Shell): Promise<GatewayProviderJson[] | null> {
  let result: ShellResult;
  try {
    result = await shell(["provider", "list", "--output", "json"]);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? (parsed as GatewayProviderJson[]) : null;
  } catch {
    return null;
  }
}

/** Null means the provider itself is absent from the gateway list — distinct
 * from present-with-no-expiry-data (`{}`), which is the normal shape for a
 * credential with no expiry (e.g. a static API key). */
function credentialExpiryFor(
  list: readonly GatewayProviderJson[],
  providerId: string,
): Record<string, number> | null {
  const entry = list.find((p) => p.name === providerId);
  if (!entry) return null;
  const raw = entry.credential_expires_at_ms;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

export type CredentialHealth = "live" | "expired" | "unknown";

/**
 * "live" iff at least one of `keys` has an expiry tracked in the gateway AND
 * that expiry is in the future (or explicitly cleared, i.e. 0). "unknown" when
 * there's no expiry bookkeeping at all for any key (e.g. gateway unreachable,
 * or a static credential with no expiry — presence is all we know). Only
 * "expired" when every key that IS tracked has already passed — this is
 * exactly the condition under which the gateway hands the sandbox zero usable
 * credentials for this provider.
 */
export function credentialHealth(
  keys: readonly string[],
  expiryByKey: Record<string, number> | null,
  nowMs: number,
): CredentialHealth {
  if (keys.length === 0 || expiryByKey === null) return "unknown";
  const tracked = keys.filter((k) => (expiryByKey[k] ?? 0) > 0);
  if (tracked.length === 0) return "unknown";
  const live = tracked.some((k) => (expiryByKey[k] ?? 0) > nowMs);
  return live ? "live" : "expired";
}

/**
 * Hard preflight: throws a user-visible error naming the provider, the
 * expiry, and the exact remediation command when the resolved provider has NO
 * live credential in the gateway. Runs after the create/update/seed logic
 * above, so a wedged-but-repairable credential (see isWedgedRefreshCredential)
 * has already been re-pushed by the time this check runs — it only fires when
 * that repair didn't happen (or wasn't applicable), i.e. genuinely nothing
 * would be injected into the sandbox.
 *
 * For a refresh-capable provider (record.refresh set) that STILL shows up
 * expired here, `openlock login` alone is not a promise this code can honor —
 * seedRefreshProvider already tried the self-heal path and either found the
 * refresh worker reporting healthy (so never-clobber correctly held off,
 * deferring to a worker tick that hasn't happened yet) or something else is
 * still wrong. Rather than advertise a fix that might not take effect on the
 * very next retry, also give the proven manual recovery: tear down sessions,
 * delete the gateway-side provider row directly, then log in again.
 */
async function assertProviderHasLiveCredential(
  providerId: ProviderId,
  shell: Shell,
): Promise<void> {
  const keys = PROVIDERS[providerId].credentialEnvVars;
  if (keys.length === 0) return;
  const list = await fetchGatewayProviderList(shell);
  if (list === null) return; // can't determine — advisory only, stay silent
  const expiryByKey = credentialExpiryFor(list, providerId);
  if (credentialHealth(keys, expiryByKey, Date.now()) !== "expired") return;

  const expiredEntries = keys
    .map((key) => ({ key, expiresAtMs: expiryByKey?.[key] ?? 0 }))
    .filter((e) => e.expiresAtMs > 0);
  const worst =
    expiredEntries.length > 0
      ? expiredEntries.reduce((a, b) => (a.expiresAtMs < b.expiresAtMs ? a : b))
      : { key: keys[0], expiresAtMs: 0 };
  const expiredAt =
    worst.expiresAtMs > 0 ? new Date(worst.expiresAtMs).toISOString() : "unknown time";

  const isRefreshCapable = readProvider(providerId)?.refresh !== undefined;
  const remediation = isRefreshCapable
    ? `Run \`openlock login --provider ${providerId}\` and retry. If the SAME sandbox start fails ` +
      `again with this error, the gateway's own repair path could not resolve it on its own: tear ` +
      `down every sandbox session using this provider, run \`${openshellCommandHint()} provider ` +
      `delete ${providerId}\`, then \`openlock login --provider ${providerId}\` again.`
    : `Run \`openlock login --provider ${providerId}\` to refresh it, then retry.`;
  throw new Error(
    `Provider '${providerId}' has no live credential in the gateway: '${worst.key}' expired at ` +
      `${expiredAt}. The sandbox would start with ZERO usable credentials for this provider and ` +
      `every request would fail. ${remediation}`,
  );
}

export interface GatewayRefreshHealth {
  status: string;
  expiresAtMs: number | null;
  lastError: string;
}

function parseGatewayTimestamp(s: string): number | null {
  if (s === "-" || s === "") return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Parse `openshell provider refresh status <name> --credential-key <key>`
 * output. Column layout (openshell-cli/src/run.rs `refresh_status_header` /
 * `refresh_status_row`): PROVIDER, CREDENTIAL_KEY, STRATEGY, STATUS,
 * EXPIRES_AT, NEXT_REFRESH, LAST_REFRESH, LAST_ERROR, columns left-justified
 * and separated by (at least) two literal spaces. EXPIRES_AT/NEXT_REFRESH/
 * LAST_REFRESH render as `YYYY-MM-DD HH:MM:SS` (a single internal space), so
 * splitting on runs of 2+ spaces recovers the 8 columns without being fooled
 * by that internal space. Returns null when the gateway reports no refresh
 * configuration for this provider/key, or the output doesn't parse.
 */
export function parseProviderRefreshStatus(stdout: string): GatewayRefreshHealth | null {
  const lines = stdout
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const fields = lines[1].split(/ {2,}/).map((f) => f.trim());
  if (fields.length < 8) return null;
  const [, , , status, expiresAtStr, , , lastErrorRaw] = fields;
  return {
    status,
    expiresAtMs: parseGatewayTimestamp(expiresAtStr),
    lastError: lastErrorRaw === "-" ? "" : lastErrorRaw,
  };
}

/**
 * NEVER-CLOBBER, relaxed NARROWLY (openlock-stj): a gateway-held refresh
 * credential is "wedged" — genuinely beyond the refresh worker's own ability
 * to repair — only when it is BOTH (a) expired per the gateway's OWN
 * bookkeeping (the same `credential_expires_at_ms` field the gateway's skip
 * check reads — see credentialHealth) AND (b) either the refresh worker's
 * last attempt ended in "error", OR no refresh status could be established
 * for this credential AT ALL.
 *
 * That second disjunct closes a gap: `fetchRefreshHealth` returns null on
 * anything from "no refresh configuration was ever pushed for this key" to a
 * transport error, and treating null as "not wedged" (as an earlier version
 * of this predicate did) reproduces openlock-stj's own failure class inside
 * its fix — an expired credential the refresh worker isn't even tracking will
 * NEVER see a status flip to "error"; it just stays expired forever, `openlock
 * login` never budges it (the local credentials.json was never the broken
 * half), and the preflight below throws the same unfixable advice on every
 * retry. The never-clobber invariant exists to protect a credential the
 * gateway can still repair on its own; when we can't even establish that a
 * refresh worker is tracking this key, there is nothing left to protect — the
 * gateway holds a token that is dead by its own bookkeeping, and the host
 * holds a strictly better one.
 *
 * A live credential is never wedged regardless of status (nothing to repair
 * yet) — this is the axis that must never widen. An expired credential the
 * worker reports healthy (a status other than "error", e.g. "configured" or
 * "refreshed") is also NOT wedged: it may still self-heal on its own next
 * tick, and broadening this predicate to cover it would re-open the clobber
 * hazard NEVER-CLOBBER exists to prevent. The remaining transient case this
 * collapses in — expired, but the worker simply hasn't ticked to "error" yet —
 * costs at worst a one-tick-early re-push of an equivalent token, which is
 * harmless.
 */
export function isWedgedRefreshCredential(
  credential: CredentialHealth,
  refreshStatus: string | null,
): boolean {
  if (credential !== "expired") return false;
  return refreshStatus === null || refreshStatus === "error";
}

/**
 * The OTHER half of never-clobber (openlock-9ej): push when the HOST holds a
 * strictly newer token than the gateway does.
 *
 * `isWedgedRefreshCredential` above only fires on an EXPIRED gateway
 * credential, because it asks "can the gateway still repair this itself?".
 * That misses the case this predicate exists for: a gateway credential that is
 * live by the clock but DEAD on the wire — an access token the issuer
 * invalidated (e.g. a second `claude auth login` rotating the session) rather
 * than one that timed out. Every openlock health signal is expiry-based, not
 * validity-based, so such a token reads `live`, sails through
 * `assertProviderHasLiveCredential`, and gets injected into the sandbox, where
 * the agent's very first request comes back `401 Invalid bearer token` with
 * nothing on the openlock side to explain it. Before this predicate there was
 * no supported way out: `openlock login` writes only the local
 * credentials.json, `openlock logout` leaves the gateway row intact, and
 * neither has a --force.
 *
 * Expiry is a sound proxy for recency here because both tokens come from the
 * same issuer with the same TTL, so a later expiry means a later mint. That
 * makes the comparison SAFE in the direction never-clobber actually cares
 * about: when the gateway's refresh worker mints a token, the gateway expiry
 * moves PAST the host's and this returns false — a freshly-refreshed gateway
 * credential is never overwritten by a stale host one, which is the whole
 * point of the invariant. It only returns true when the host demonstrably has
 * the newer material, i.e. right after an interactive login.
 *
 * Returns false when the gateway tracks no expiry for the key (`undefined`, or
 * the explicit 0 meaning "cleared"): with nothing to compare against, there is
 * no evidence the host is ahead, so stay never-clobber.
 */
export function hostTokenIsNewer(
  hostAccessExpiresAt: string | undefined,
  gatewayExpiryMs: number | undefined,
): boolean {
  if (!hostAccessExpiresAt) return false;
  if (gatewayExpiryMs === undefined || gatewayExpiryMs <= 0) return false;
  const hostMs = Date.parse(hostAccessExpiresAt);
  if (Number.isNaN(hostMs)) return false;
  return hostMs > gatewayExpiryMs;
}

async function fetchRefreshHealth(
  providerId: ProviderId,
  credentialKey: string,
  shell: Shell,
): Promise<GatewayRefreshHealth | null> {
  let result: ShellResult;
  try {
    result = await shell([
      "provider",
      "refresh",
      "status",
      providerId,
      "--credential-key",
      credentialKey,
    ]);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  return parseProviderRefreshStatus(result.stdout);
}

export interface ProviderGatewayHealth {
  inGateway: boolean;
  credential: CredentialHealth;
  refresh: "ok" | "error" | null;
}

/** Real gateway credential health for `openlock providers` (openlock-7mh):
 * presence (`in_gateway`) alone is misleading when the credential behind it is
 * dead. Reports the SAME expiry signal the gateway's own skip check uses, plus
 * (for refresh-capable providers) whether the refresh worker's last attempt
 * errored. */
export async function getProviderGatewayHealth(
  providerId: ProviderId,
): Promise<ProviderGatewayHealth> {
  return _getProviderGatewayHealthForTests(providerId, realOpenshell);
}

export async function _getProviderGatewayHealthForTests(
  providerId: ProviderId,
  shell: Shell,
): Promise<ProviderGatewayHealth> {
  const keys = PROVIDERS[providerId].credentialEnvVars;
  const list = await fetchGatewayProviderList(shell);
  const expiryByKey = list ? credentialExpiryFor(list, providerId) : null;
  const inGateway = expiryByKey !== null;
  const credential = credentialHealth(keys, expiryByKey, Date.now());

  let refresh: "ok" | "error" | null = null;
  const record = readProvider(providerId);
  if (inGateway && record?.refresh && keys.length > 0) {
    const health = await fetchRefreshHealth(providerId, keys[0], shell);
    refresh = health ? (health.status === "error" ? "error" : "ok") : null;
  }
  return { inGateway, credential, refresh };
}

// Explicit env var name for `--secret-material-env refresh_token=<name>` below
// (openshell-cli resolves the value from this exact env var on the spawned
// process; the name itself is arbitrary, just needs to not collide with
// anything else set on that process's env).
const REFRESH_TOKEN_ENV_VAR = "OPENLOCK_REFRESH_TOKEN";

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

  // `provider profile import` is NOT idempotent — re-importing an existing
  // profile id errors ("already exists"). Probe with `provider profile export`
  // (exit 0 = present) and import ONLY when absent, so reattaches and re-seeds
  // (provider deleted but the profile still registered) don't crash. Run on
  // every ensure (not gated on the provider's existence) so a profile that was
  // somehow lost is restored, while a present one is left untouched.
  const profilePresent =
    (await shell(["provider", "profile", "export", CLAUDE_OAUTH_PROFILE_ID])).exitCode === 0;
  if (!profilePresent) {
    const dir = mkdtempSync(join(tmpdir(), "olk-prof-"));
    try {
      const profPath = join(dir, `${CLAUDE_OAUTH_PROFILE_ID}.yaml`);
      writeFileSync(profPath, buildClaudeOAuthProfileYaml(refresh));
      // mustOk awaits, so import completes before the finally removes the dir.
      await mustOk(shell, ["provider", "profile", "import", "--file", profPath]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // See isWedgedRefreshCredential's doc comment for the exact predicate. Only
  // query the gateway (two extra round trips: the canonical expiry field plus
  // the refresh worker's own status) when the provider already exists —
  // there's nothing to clobber-check on a fresh create. "Expired" is read from
  // the SAME `credential_expires_at_ms` field the gateway's own skip check
  // uses (not the refresh worker's own tracked expiry, which per a prior
  // incident can drift from it) so this predicate can't be fooled by that
  // drift.
  let shouldPush = !exists;
  if (exists) {
    const list = await fetchGatewayProviderList(shell);
    const expiryByKey = list ? credentialExpiryFor(list, providerId) : null;
    const credential = credentialHealth(["ANTHROPIC_BEARER_TOKEN"], expiryByKey, Date.now());
    const health = await fetchRefreshHealth(providerId, "ANTHROPIC_BEARER_TOKEN", shell);
    shouldPush =
      isWedgedRefreshCredential(credential, health ? health.status : null) ||
      // Second disjunct (openlock-9ej): the gateway credential can be live by
      // the clock yet already rejected on the wire. See hostTokenIsNewer.
      hostTokenIsNewer(refresh.access_expires_at, expiryByKey?.ANTHROPIC_BEARER_TOKEN);
  }

  if (shouldPush) {
    const access = record.credentials.ANTHROPIC_BEARER_TOKEN;
    if (!access) {
      throw new Error(
        `Provider '${providerId}' record has refresh material but no ANTHROPIC_BEARER_TOKEN credential; re-run \`openlock login\`.`,
      );
    }
    const { args: createCredArgs, env: createCredEnv } = credentialArgsAndEnv({
      ANTHROPIC_BEARER_TOKEN: access,
    });
    // create-or-update, mirroring the generic branch below (openlock-45h).
    // `shouldPush` is true in two situations — the provider is ABSENT, or it
    // exists and needs re-pushing — and only the first can use `provider
    // create`: the gateway persists CreateProvider with
    // WriteCondition::MustCreate and answers `already_exists` otherwise
    // (openshell-server/src/grpc/provider.rs), so issuing `create` against a
    // live provider hard-fails. That made every re-push path unreachable:
    // a credential the gateway could no longer repair on its own threw
    // `provider already exists` on each retry instead of self-healing.
    await mustOk(
      shell,
      exists
        ? ["provider", "update", providerId, ...createCredArgs]
        : ["provider", "create", "--name", providerId, "--type", record.type, ...createCredArgs],
      createCredEnv,
    );
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
    //
    // The refresh token is a long-lived OAuth secret, so it travels via
    // `--secret-material-env refresh_token=<ENVVAR>` + the spawned process's
    // env, not inline on `--material` (which would land in the world-readable
    // /proc/<pid>/cmdline for the process lifetime — same class of bug as
    // credentialArgsAndEnv fixes for `--credential`). `parse_secret_material_env_pairs`
    // (openshell-cli/src/commands/common.rs) resolves `KEY=ENVVAR` from the CLI
    // process's own env and auto-adds `KEY` to secret_material_keys, so a
    // separate `--secret-material-key refresh_token` is redundant here (and,
    // per provider_refresh_config in run.rs, only errors on an overlap between
    // --material and --secret-material-env, not on this kind of redundancy —
    // it's dropped for clarity, not to dodge an error).
    // `client_id` is not secret and stays on `--material` as-is.
    await mustOk(
      shell,
      [
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
        "--secret-material-env",
        `refresh_token=${REFRESH_TOKEN_ENV_VAR}`,
        "--credential-expires-at",
        refresh.access_expires_at,
      ],
      { [REFRESH_TOKEN_ENV_VAR]: refresh.refresh_token },
    );
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
  // profile idempotently, seeds create/update/configure on a fresh provider,
  // and re-seeds an existing one ONLY when it's wedged (see
  // isWedgedRefreshCredential) — never-clobbering a live or healthily-
  // refreshing credential.
  if (record.refresh) {
    await seedRefreshProvider(providerId, record, exists, shell);
  } else {
    const { args: credArgs, env: credEnv } = credentialArgsAndEnv(record.credentials);
    const args = exists
      ? ["provider", "update", providerId, ...credArgs]
      : ["provider", "create", "--name", providerId, "--type", record.type, ...credArgs];

    const result = await shell(args, credEnv);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to ${exists ? "update" : "create"} provider '${providerId}' in gateway: ${result.stderr}`,
      );
    }

    warnOnTypeDrift(providerId, record);
  }

  // Preflight (openlock-7mh): after the above, confirm the gateway actually
  // holds a live credential for this provider. Fires ONLY when the repair
  // above didn't happen or wasn't applicable — a wedged refresh credential was
  // already re-pushed by seedRefreshProvider, so this is a hard, user-visible
  // failure for the residual case where nothing would be injected into the
  // sandbox and the gateway would otherwise skip it in silence.
  await assertProviderHasLiveCredential(providerId, shell);
}

/**
 * Remove a provider row from the GATEWAY (openlock-9ej). Distinct from
 * `deleteProvider` in tokens.ts, which only removes the host-side
 * credentials.json entry — the two together are what "log out" has to mean,
 * because the gateway row is the copy that actually gets injected into a
 * sandbox. Leaving it behind is how a revoked token kept being served long
 * after the user believed they had logged out.
 *
 * Best-effort by contract: returns false (never throws) when the gateway is
 * unreachable or has no such provider, so `openlock logout` still succeeds at
 * clearing local state on a machine whose gateway is stopped. Callers report
 * the outcome rather than failing on it.
 */
export async function deleteGatewayProvider(name: string): Promise<boolean> {
  return _deleteGatewayProviderForTests(name, realOpenshell);
}

export async function _deleteGatewayProviderForTests(name: string, shell: Shell): Promise<boolean> {
  try {
    const list = await shell(["provider", "list"]);
    if (list.exitCode !== 0) return false;
    if (!providerExistsInGateway(list.stdout, name)) return false;
    const result = await shell(["provider", "delete", name]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Provision a generic secondary-credential provider (create-or-update) from a
 * resolved {credKey: value} bundle. Type is always `generic`. Never surfaces the
 * credential VALUE in errors — only the provider name + openshell stderr. */
export async function ensureGenericProvider(
  name: string,
  values: Record<string, string>,
): Promise<void> {
  await _ensureGenericProviderForTests(name, values, realOpenshell);
}

export async function _ensureGenericProviderForTests(
  name: string,
  values: Record<string, string>,
  shell: Shell,
): Promise<void> {
  const list = await shell(["provider", "list"]);
  if (list.exitCode !== 0) {
    throw new Error(`Failed to query gateway providers: ${list.stderr || list.stdout}`);
  }
  const exists = providerExistsInGateway(list.stdout, name);
  const { args: credArgs, env: credEnv } = credentialArgsAndEnv(values);
  const args = exists
    ? ["provider", "update", name, ...credArgs]
    : ["provider", "create", "--name", name, "--type", "generic", ...credArgs];
  const result = await shell(args, credEnv);
  if (result.exitCode !== 0) {
    // Deliberately omit `args` (carries the credential value) from the message.
    throw new Error(
      `Failed to ${exists ? "update" : "create"} credential provider '${name}' in gateway: ${result.stderr}`,
    );
  }
}
