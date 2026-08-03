/**
 * openlock-p60: opencode's model picker for the openrouter provider lists
 * OpenRouter's entire public catalog (367 models, measured 2026-07-30)
 * regardless of what the configured key may actually use — `GET
 * /api/v1/models/user`, which honors account restrictions, reports exactly 8
 * usable entries for that same key. Nothing distinguishes the 8 from the
 * other 359, and picking a disallowed one produces OpenRouter's `No
 * endpoints available matching your guardrail restrictions and data policy`,
 * which reads like an account/privacy fault rather than "not in your
 * allowlist" — it already caused one wrong diagnosis in this project.
 *
 * openlock-4g1 shipped the CAPABILITY half of this (whether a model supports
 * tool use — public information, `supported_parameters` on the
 * unauthenticated `GET /api/v1/models`, see
 * ../sandbox/opencode-openrouter-model-gate.ts). This module is the
 * PERMISSION half: which models the configured key is actually *allowed* to
 * use, which requires the credential and is therefore openlock's FIRST
 * host-side authenticated provider API call. Routers are not exempt from
 * this — `openrouter/fusion`, `openrouter/pareto-code`, and
 * `openrouter/bodybuilder` are all permitted-but-tools-incapable for a real
 * key observed during this investigation, so this module reports
 * capability per entry rather than treating "router" as its own safe class.
 */
import { readProvider } from "../tokens";
import type { ProviderId } from "./types";

/** One entry from OpenRouter's authenticated `/api/v1/models/user` endpoint.
 * Same shape as the public `/api/v1/models` catalog entry (see
 * ../sandbox/opencode-openrouter-model-gate.ts's OpenRouterModelEntry) —
 * `supported_parameters` is how tool-use capability is read either way. */
interface OpenRouterUserModelEntry {
  id: string;
  supported_parameters?: readonly string[];
}

interface OpenRouterUserModelsResponse {
  data: readonly OpenRouterUserModelEntry[];
}

/** Raw result of one authenticated request, deliberately un-parsed on the
 * error path — the caller needs `status`/`body` to distinguish an ordinary
 * HTTP failure from OpenRouter's own error-message shape. */
export interface FetchOpenRouterUserModelsResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
}

/**
 * Fetches the OpenRouter models the configured credential is permitted to
 * use. Injectable and REQUIRED — no default. This is openlock's first
 * HOST-SIDE AUTHENTICATED provider API call (openlock-p60): unlike the
 * read-only public-catalog fetchers elsewhere in this codebase
 * (../sandbox/resolve-harness-version.ts, sibling
 * opencode-openrouter-model-gate.ts), a stray real invocation during a test
 * run would spend the user's real key against a live account. Every caller
 * must pass a real implementation explicitly; there is no silent fallback
 * that reaches the network.
 */
export type FetchOpenRouterUserModels = (
  authHeader: string,
) => Promise<FetchOpenRouterUserModelsResult>;

const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";

export const fetchOpenRouterUserModelsFromApi: FetchOpenRouterUserModels = async (authHeader) => {
  const res = await fetch(OPENROUTER_USER_MODELS_URL, {
    headers: { Authorization: authHeader },
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, body };
};

interface PermittedModel {
  id: string;
  toolsSupported: boolean;
}

export type ProviderModelsResult =
  | { kind: "unsupported-provider" }
  | { kind: "missing-credential" }
  | { kind: "request-failed"; status: number; message: string }
  | { kind: "ok"; models: readonly PermittedModel[] };

/** Translates a failed response into a message that names the real cause.
 * OpenRouter's error body for a disallowed request is shaped like
 * `{ error: { message: "..." } }`; when that message is the "guardrail
 * restrictions" wording, restate it plainly (per openlock-4g1's own finding
 * that the raw wording reads as an account/privacy fault) rather than
 * parroting it as the whole story. Any other message is passed through
 * as-is; a body with no parseable message falls back to the HTTP status
 * line. */
function describeRequestFailure(res: FetchOpenRouterUserModelsResult): string {
  const body = res.body as { error?: { message?: unknown } } | undefined;
  const raw = typeof body?.error?.message === "string" ? body.error.message : undefined;
  if (raw !== undefined) {
    if (/guardrail/i.test(raw)) {
      return (
        `not permitted for this key (OpenRouter: "${raw}") — this means the request is outside ` +
        "this key's allowlist, not an account or privacy problem."
      );
    }
    return raw;
  }
  return `${res.status} ${res.statusText}`;
}

/**
 * Resolves which OpenRouter models `id`'s stored credential is permitted to
 * use, plus per-model tool-use capability (same `supported_parameters`
 * convention as the public-catalog check in
 * ../sandbox/opencode-openrouter-model-gate.ts).
 *
 * `anthropic` has no equivalent to `/api/v1/models/user` — there is no
 * account-scoped model allowlist concept for it in this codebase — so it
 * reports `unsupported-provider` rather than silently returning an empty or
 * fabricated list.
 */
export async function getPermittedModels(
  id: ProviderId,
  fetchUserModels: FetchOpenRouterUserModels,
): Promise<ProviderModelsResult> {
  if (id !== "openrouter") {
    return { kind: "unsupported-provider" };
  }
  // openrouter.ts's loginInteractive stores the value WITH the "Bearer "
  // prefix inline (`Bearer ${key}`) — unlike anthropic, whose stored token is
  // raw and gets "Bearer " added by the gateway's cred_inject value_prefix at
  // egress. Since this is a direct host-side fetch (no gateway in the path),
  // the stored openrouter value is already the complete Authorization header.
  const record = readProvider(id);
  const authHeader = record?.credentials.OPENROUTER_BEARER_TOKEN;
  if (authHeader === undefined) {
    return { kind: "missing-credential" };
  }
  const res = await fetchUserModels(authHeader);
  if (!res.ok) {
    return { kind: "request-failed", status: res.status, message: describeRequestFailure(res) };
  }
  const body = res.body as OpenRouterUserModelsResponse;
  const models: PermittedModel[] = (body.data ?? []).map((m) => ({
    id: m.id,
    toolsSupported: (m.supported_parameters ?? []).includes("tools"),
  }));
  return { kind: "ok", models };
}

/** Renders `getPermittedModels`'s result as plain-text lines for the CLI.
 * Routers are deliberately NOT grouped or labeled as a safe class — of the 5
 * routers a real permitted set was observed to include, only 2
 * (`openrouter/auto`, `openrouter/auto-beta`) declare tool support; the
 * other 3 (`openrouter/fusion`, `openrouter/pareto-code`,
 * `openrouter/bodybuilder`) do not. Per-entry `tools=yes/no` is the useful
 * signal, not a router/model distinction. */
export function renderProviderModelsResult(id: ProviderId, result: ProviderModelsResult): string[] {
  switch (result.kind) {
    case "unsupported-provider":
      return [
        `openlock providers models: "${id}" has no equivalent to OpenRouter's authenticated ` +
          '/api/v1/models/user endpoint — this command is only supported for provider "openrouter".',
      ];
    case "missing-credential":
      return [
        `openlock providers models: no stored credentials for provider "${id}" — run ` +
          "`openlock login --provider openrouter` first.",
      ];
    case "request-failed":
      return [
        `openlock providers models: OpenRouter request failed (HTTP ${result.status}): ` +
          `${result.message}`,
      ];
    case "ok": {
      if (result.models.length === 0) {
        return [
          "No models are permitted for this key (0 entries from OpenRouter's " +
            "/api/v1/models/user).",
        ];
      }
      const lines = result.models.map((m) => `${m.id}  tools=${m.toolsSupported ? "yes" : "no"}`);
      lines.push("");
      lines.push(
        `${result.models.length} model(s) permitted for this key (source: OpenRouter's ` +
          "authenticated /api/v1/models/user, not the public catalog).",
      );
      lines.push(
        "A model NOT listed above is outside this key's permitted set. Trying to use it " +
          "produces OpenRouter's own error \"No endpoints available matching your guardrail " +
          "restrictions and data policy\" — that means the model is not in this key's allowlist, " +
          "not an account or privacy problem.",
      );
      return lines;
    }
  }
}
