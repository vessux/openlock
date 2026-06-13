import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginIO, LoginResult } from "./types";

const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_SCOPES = ["user:profile", "user:inference"];

/** Parse the `claudeAiOauth` credential Claude Code stores after `claude auth
 * login` (macOS Keychain secret / Linux .credentials.json) into an openlock
 * LoginResult. The access token is stored RAW (no "Bearer " prefix) — the
 * gateway adds the prefix via the policy cred_inject value_prefix at egress. */
export function parseClaudeOauthBlob(raw: string): LoginResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Claude Code credential is not valid JSON.");
  }
  const o = ((parsed.claudeAiOauth as Record<string, unknown>) ?? parsed) as Record<
    string,
    unknown
  >;
  const accessToken = o.accessToken as string | undefined;
  const refreshToken = o.refreshToken as string | undefined;
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Claude Code credential is missing accessToken/refreshToken (was this a subscription login?).",
    );
  }
  const expiresAtMs =
    typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt)
      ? o.expiresAt
      : Date.now() + 3600_000;
  const scopes =
    Array.isArray(o.scopes) && o.scopes.length > 0 ? (o.scopes as string[]) : [...DEFAULT_SCOPES];
  return {
    credentials: { ANTHROPIC_BEARER_TOKEN: accessToken },
    refresh: {
      strategy: "oauth2_refresh_token",
      token_url: CLAUDE_OAUTH_TOKEN_URL,
      scopes,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
      access_expires_at: new Date(expiresAtMs).toISOString(),
    },
  };
}

/** The macOS Keychain service name Claude Code uses for its credential item,
 * derived from its config dir `dir`. CC builds it as
 * `Claude Code` + OAUTH_FILE_SUFFIX("" for a stock build) + "-credentials" +
 * "-" + sha256(dir).hex.slice(0,8). realImportDeps points BOTH CLAUDE_CONFIG_DIR
 * and CLAUDE_SECURESTORAGE_CONFIG_DIR at the same throwaway dir, so whichever CC
 * keys the hash off, this computes the identical name — we read exactly the one
 * item CC just created, never the user's real credential. (The `.normalize("NFC")`
 * is a no-op for our ASCII mkdtemp paths; the file fallback in importFromClaudeCode
 * covers any residual item-name mismatch.) */
export function claudeKeychainService(dir: string): string {
  const suffix = createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

/** Injected I/O for importFromClaudeCode so the orchestration is testable
 * without spawning `claude` or touching a real Keychain. */
export interface ImportDeps {
  platform: NodeJS.Platform;
  hasClaude(): boolean;
  /** Make + return a fresh throwaway config dir path. */
  makeConfigDir(): string;
  /** Spawn `claude auth login --claudeai` with the throwaway config dir,
   * inheriting the TTY. Resolves to the process exit code. */
  spawnLogin(configDir: string): Promise<number>;
  /** Read a credential file (Linux). null if absent/unreadable. */
  readFile(path: string): string | null;
  /** Read a Keychain item secret by service name (macOS). null if absent. */
  readKeychain(service: string): string | null;
  /** Delete a Keychain item by service name (macOS cleanup). Best-effort. */
  deleteKeychain(service: string): void;
  /** Remove the throwaway config dir. Best-effort. */
  removeDir(dir: string): void;
}

/** Orchestrate an isolated Claude Code subscription login and harvest the token
 * it stores. The real subscription token lands only in openlock's own
 * credentials file (via the returned LoginResult); the throwaway CC store is
 * erased. The user's own Claude Code credentials are never touched. */
export async function importFromClaudeCode(io: LoginIO, deps: ImportDeps): Promise<LoginResult> {
  if (!deps.hasClaude()) {
    throw new Error(
      "Claude Code CLI ('claude') not found on PATH. Install Claude Code (so `claude auth login` works), then retry `openlock login`.",
    );
  }
  const configDir = deps.makeConfigDir();
  const service = deps.platform === "darwin" ? claudeKeychainService(configDir) : null;
  try {
    io.writeStdout(
      "Opening an isolated Claude Code subscription login. Complete the browser sign-in; your own Claude Code login is untouched.\n",
    );
    const code = await deps.spawnLogin(configDir);
    if (code !== 0) {
      throw new Error(`Claude Code login exited with code ${code}.`);
    }
    // On macOS, Claude Code's credential store is a composite: it prefers the
    // Keychain but falls back to writing configDir/.credentials.json when the
    // Keychain is unavailable (locked, headless/CI, SSH session, access denied).
    // So read the Keychain first, then fall back to the file — the same path the
    // Linux branch reads. Reading the file is also a safety net against any
    // Keychain item-name mismatch.
    const credFile = join(configDir, ".credentials.json");
    const raw =
      deps.platform === "darwin"
        ? (deps.readKeychain(service as string) ?? deps.readFile(credFile))
        : deps.readFile(credFile);
    if (!raw) {
      throw new Error(
        "Could not read the credential Claude Code stored after login. Did the subscription login complete?",
      );
    }
    return parseClaudeOauthBlob(raw);
  } finally {
    if (deps.platform === "darwin" && service) {
      try {
        deps.deleteKeychain(service);
      } catch {
        // best-effort cleanup
      }
    }
    deps.removeDir(configDir);
  }
}

/** Production wiring for ImportDeps. */
export function realImportDeps(): ImportDeps {
  return {
    platform: process.platform,
    hasClaude: () => Bun.which("claude") !== null,
    makeConfigDir: () => mkdtempSync(join(tmpdir(), "openlock-cc-login-")),
    async spawnLogin(configDir: string): Promise<number> {
      const proc = Bun.spawn(["claude", "auth", "login", "--claudeai"], {
        // Set BOTH: CLAUDE_CONFIG_DIR isolates all CC state; and
        // CLAUDE_SECURESTORAGE_CONFIG_DIR makes the macOS Keychain item name
        // deterministic (see claudeKeychainService).
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return await proc.exited;
    },
    readFile(path: string): string | null {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    readKeychain(service: string): string | null {
      const r = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"]);
      if (r.exitCode !== 0) return null;
      const out = r.stdout.toString().trim();
      return out.length > 0 ? out : null;
    },
    deleteKeychain(service: string): void {
      Bun.spawnSync(["security", "delete-generic-password", "-s", service]);
    },
    removeDir(dir: string): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
