// The ONE sanctioned way for a test to read the operator's REAL
// `~/.config/openlock/credentials.json` (bd openlock-q7b8, split from
// openlock-6pwu). Extracted from `tests/integration/post-create-openrouter-
// real.test.ts`, which is a deliberate, documented exception to the
// tests-use-synthetic-state-only policy (feedback_tests_synthetic_state_
// only.md): it proves the post-create exec path delivers an AUTHENTICATED
// request to the real OpenRouter API, which needs a real bearer token —
// there is no synthetic substitute for "does the real upstream accept this
// token". CI never runs it (no real key in CI secrets); it is local-only.
//
// WHY THIS FILE EXISTS RATHER THAN LEAVING THE READ INLINE: before this
// extraction, the exception existed only as a comment ("Double-gated:
// OPENLOCK_LIVE_INTEGRATION=1 ... real OpenRouter creds ...") — nothing
// stopped a second file from reaching for the same raw
// `homedir()`/`.config`/`openlock` construction the hard way, which is the
// EXACT shape of both this project's real credential-loss incidents
// (neither went through `src/tokens.ts` at all). `scripts/check-real-
// state-access.ts` now enforces that this file is the ONLY place in the
// tree allowed to build that path — see that script's header for the
// allowlist and why it exists.
//
// READ-ONLY BY CONSTRUCTION: this module offers no write/delete export, on
// purpose — there must be no way to reuse this file to justify a MUTATION
// of real credentials.json. If a future test needs to write real
// credentials, that is a new, separate, and much more dangerous exception
// that needs its own explicit design (and, per feedback_tests_synthetic_
// state_only.md, a very strong reason to exist at all) — it must NOT be
// added here.
//
// OPENLOCK_LIVE_INTEGRATION IS CHECKED INSIDE THIS FUNCTION, not left to the
// caller. Real credentials.json is never even opened unless
// `OPENLOCK_LIVE_INTEGRATION === "1"` — so calling this function from a
// hermetic (non-LIVE) run is a guaranteed no-op `null`, not a skipped
// safety check the caller could forget. This is a change from the
// pre-extraction code, which read the real file UNCONDITIONALLY at module
// top level (so a plain `bun run test` touched — read-only, but touched —
// the real credentials file on every run); this version restores the
// "never touch real state unless LIVE" invariant the rest of the suite
// already follows.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CredentialsFileShape {
  providers?: Record<string, { credentials?: Record<string, string> }>;
}

/**
 * Reads the real, on-disk OpenRouter bearer token from the operator's
 * `~/.config/openlock/credentials.json`, or `null` if any of the following
 * hold: `OPENLOCK_LIVE_INTEGRATION` is not exactly `"1"`, the file doesn't
 * exist, it can't be parsed, or it has no `openrouter` provider with a
 * bearer token recorded. All of those collapse to the same `null` — the
 * caller's job is only to decide whether to run at all
 * (`it.skipIf(bearer === null)`), never to distinguish why a token wasn't
 * available.
 */
export function loadRealOpenRouterBearerForLiveIntegrationOnly(): string | null {
  if (process.env.OPENLOCK_LIVE_INTEGRATION !== "1") return null;

  const credPath = join(homedir(), ".config", "openlock", "credentials.json");
  if (!existsSync(credPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(credPath, "utf-8")) as CredentialsFileShape;
    return raw.providers?.openrouter?.credentials?.OPENROUTER_BEARER_TOKEN ?? null;
  } catch {
    return null;
  }
}
