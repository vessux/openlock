/**
 * openlock-4g1: opencode's own model picker/default draws from OpenRouter's
 * full public catalog (~367 models as of 2026-07-30) with no regard for
 * whether the configured OpenRouter key may actually use a given model or
 * whether that model supports tool use at all. A fresh opencode+openrouter
 * sandbox auto-selected "Nano Banana Pro" (an image-only model) and the first
 * tool-using prompt failed with OpenRouter's `No endpoints found that support
 * tool use. Try disabling bash.` Manually picking a model is no better: most
 * of the catalog is disallowed for a given key, and OpenRouter's rejection
 * for THAT case (`No endpoints available matching your guardrail
 * restrictions and data policy`) reads like an account/privacy problem, not
 * "wrong model" — it produced one wrong diagnosis in this project already.
 *
 * This module narrows the tool-use half of that: whether a model *supports*
 * tool use is public information (`supported_parameters` on the
 * unauthenticated `GET /api/v1/models` catalog), so it can be checked before
 * ever handing the prompt to opencode. Whether the configured KEY is allowed
 * to use that model is a separate, credential-scoped question (permission,
 * not capability) split out to openlock-p60 — deliberately NOT handled here.
 *
 * Two checks, run before the opencode process is launched:
 *  1. No --model in args at all -> WARN, not block. This was originally
 *     implemented as a hard block ("openlock never guesses a model default,
 *     so require one"), but that forbids a real, currently-used, legitimate
 *     workflow: launching opencode+openrouter with no --model configured and
 *     picking a model INTERACTIVELY IN OPENCODE'S OWN TUI once inside — which
 *     is exactly what happened during this bug's own investigation
 *     (openlock-4g1 notes: "I picked DeepSeek Chat, then Claude Opus 4.5,
 *     then GPT-5.1 Chat", all in-TUI, on a sandbox launched with no --model).
 *     A hard block here would have forbidden the user's own debugging
 *     session. So this case warns with the full diagnosis (opencode's
 *     catalog-wide default can be a non-tool-use model, name the observed
 *     culprit, name the failure mode) and BOTH remedies (set --model in
 *     config, or pick one in-TUI) and then proceeds. Do not "tighten" this
 *     back into a block without re-checking that in-TUI flow still exists —
 *     that was a deliberate, escalated product decision (2026-07-30), not an
 *     oversight.
 *  2. --model IS set but the public catalog says it lacks tool support ->
 *     BLOCK. Unlike case 1, this is a verifiably wrong, user-authored
 *     config — there is no ambiguity to preserve an in-TUI fallback for, so
 *     failing fast is correct. The message names the real cause up front,
 *     because OpenRouter's own runtime error for this case does not.
 * A catalog lookup FAILURE (network error, or the model id simply absent
 * from the response) is NOT evidence the model lacks tool support — it is
 * evidence openlock could not check. Per the project's no-silent-failure
 * discipline (v0.11.2 sweep: openlock must never do the wrong thing quietly
 * while reporting success), this warns loudly rather than either blocking
 * (would make openlock unusable offline / on a flaky network) or passing
 * silently (would look identical to a verified-safe launch).
 */

interface OpenRouterModelEntry {
  id: string;
  supported_parameters?: readonly string[];
}

export interface OpenRouterModelsResponse {
  data: readonly OpenRouterModelEntry[];
}

/** Fetches OpenRouter's public model catalog. Injectable so callers (CLI,
 * tests) never have to hit the real network — mirrors the
 * FetchDistTags/resolveHarnessVersion precedent in ./resolve-harness-version.ts. */
export type FetchOpenRouterModels = () => Promise<OpenRouterModelsResponse>;

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FREE_MODELS_URL = "https://openrouter.ai/models?max_price=0";

const fetchOpenRouterModelsFromApi: FetchOpenRouterModels = async () => {
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) {
    throw new Error(`OpenRouter models catalog request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as OpenRouterModelsResponse;
};

/**
 * Extracts the value of a `--model` flag from opencode CLI args (openlock's
 * `args:` passthrough list — plain strings, no delimiter parsing happens
 * anywhere upstream of this, see config-core/manifest/schema.ts). Handles
 * both forms a hand-edited config.yaml can produce:
 *   - two elements: ["--model", "openrouter/x"]  (what scaffold.ts renders)
 *   - one element:  ["--model=openrouter/x"]     (valid YAML, never rendered
 *                                                  by openlock but not
 *                                                  rejected by schema either)
 * On repeated `--model` flags, the LAST occurrence wins (matches common CLI
 * parser convention: later flags override earlier ones).
 */
export function extractModelArg(args: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model") {
      const value = args[i + 1];
      if (value !== undefined) {
        found = value;
        i++; // consumed as this flag's value, not a flag of its own
      }
      continue;
    }
    if (a?.startsWith("--model=")) {
      found = a.slice("--model=".length);
    }
  }
  return found;
}

export type ModelCapabilityResult =
  | { kind: "supported" }
  | { kind: "unsupported" }
  | { kind: "unknown" } // model id absent from the catalog response
  | { kind: "lookup-failed"; error: Error };

const OPENROUTER_PREFIX = "openrouter/";

/**
 * Resolves a model id against the catalog by trying, IN THIS ORDER:
 *   1. the literal string, then
 *   2. the string with exactly one leading "openrouter/" stripped.
 *
 * Order is load-bearing, not stylistic. opencode addresses OpenRouter models
 * as `<opencode-provider>/<openrouter-model-id>` — since the opencode
 * provider here is itself named "openrouter", a user-authored id carries an
 * `openrouter/` prefix that OpenRouter's own catalog ids do NOT have for
 * ordinary models. openlock's own scaffold (config-core/manifest/scaffold.ts)
 * tells users to write exactly this prefixed form, e.g.
 * `openrouter/nvidia/nemotron-3-super-120b-a12b:free`.
 *
 * But OpenRouter's 6 router aliases are the opposite: their OWN catalog id
 * genuinely INCLUDES the `openrouter/` segment (`openrouter/auto`,
 * `openrouter/auto-beta`, `openrouter/free`, `openrouter/fusion`,
 * `openrouter/pareto-code`, `openrouter/bodybuilder`) — verified against the
 * live 367-entry catalog on 2026-07-30/08-01. Bare `free` is NOT a catalog
 * entry. So for `openrouter/free`, stripping first would look up the
 * nonexistent bare `free` and silently misreport an "unknown" model that is
 * actually a perfectly valid, tool-capable router — trying the literal form
 * FIRST is what keeps that case correct. Do not "simplify" this back to a
 * single strip-then-compare or a single as-is compare: either one silently
 * re-inerts the gate for one of the two real id shapes production sees (see
 * openlock-4g1: the original single-literal-comparison version above this
 * function never matched ANY real user-authored id, including the exact
 * image-model culprit the bug is about, and degraded every launch to a
 * permanent "could not verify" warning instead of the intended block).
 */
function resolveModelInCatalog(
  catalog: OpenRouterModelsResponse,
  modelId: string,
): OpenRouterModelEntry | undefined {
  const literal = catalog.data.find((m) => m.id === modelId);
  if (literal) return literal;
  if (!modelId.startsWith(OPENROUTER_PREFIX)) return undefined;
  const stripped = modelId.slice(OPENROUTER_PREFIX.length);
  if (stripped.length === 0) return undefined;
  return catalog.data.find((m) => m.id === stripped);
}

/** Checks whether `modelId` supports tool use per OpenRouter's public model
 * catalog. Never throws — network/parse failures and "model not found" both
 * come back as non-"supported"/"unsupported" kinds so the caller can tell
 * "verified bad" apart from "could not verify". */
export async function checkModelSupportsTools(
  modelId: string,
  fetchModels: FetchOpenRouterModels = fetchOpenRouterModelsFromApi,
): Promise<ModelCapabilityResult> {
  let catalog: OpenRouterModelsResponse;
  try {
    catalog = await fetchModels();
  } catch (e) {
    return { kind: "lookup-failed", error: e instanceof Error ? e : new Error(String(e)) };
  }
  const model = resolveModelInCatalog(catalog, modelId);
  if (!model) return { kind: "unknown" };
  const supportsTools = (model.supported_parameters ?? []).includes("tools");
  return { kind: supportsTools ? "supported" : "unsupported" };
}

export type ModelGateResult =
  | { action: "proceed" }
  | { action: "block"; message: string }
  | { action: "warn"; message: string };

/**
 * The full launch-time gate for the opencode+openrouter combination. Callers
 * (runSandbox) should invoke this only when `harness === "opencode" &&
 * providerId === "openrouter"` — it is not meaningful for any other pairing
 * (anthropic isn't even opencode-compatible, see providers/resolve.ts, and
 * claude_code has its own, unrelated model-selection story).
 */
export async function gateOpencodeOpenRouterModel(
  args: readonly string[],
  fetchModels: FetchOpenRouterModels = fetchOpenRouterModelsFromApi,
): Promise<ModelGateResult> {
  const modelId = extractModelArg(args);
  if (modelId === undefined) {
    return {
      action: "warn",
      message: [
        "opencode + openrouter: no --model set — proceeding, but read this first.",
        "opencode picks its own default from OpenRouter's full public catalog with no regard for",
        'tool-use support. It has been observed picking "google/gemini-3-pro-image-preview"',
        '("Nano Banana Pro"), an image model. If your first prompt fails with OpenRouter\'s',
        '"No endpoints found that support tool use" error, THIS is the cause — it is not an',
        "account, auth, or privacy problem.",
        "Two ways to fix it:",
        "  - pick a tool-capable model interactively once inside opencode, or",
        "  - set --model up front in args in .openlock/config.yaml, e.g.:",
        "      args:",
        "        - --model",
        "        - openrouter/<model-id>",
        `Either way, see ${FREE_MODELS_URL} for currently free, tool-capable options.`,
      ].join("\n"),
    };
  }

  const result = await checkModelSupportsTools(modelId, fetchModels);
  switch (result.kind) {
    case "supported":
      return { action: "proceed" };
    case "unsupported":
      return {
        action: "block",
        message: [
          `opencode + openrouter: model "${modelId}" does not support tool use, per OpenRouter's`,
          'public model catalog (supported_parameters lacks "tools") — opencode\'s build agent',
          "requires tools, so this WILL fail on the first prompt.",
          "This is a model-capability problem, not an account, auth, or privacy problem: if you",
          'launch anyway, OpenRouter rejects the request with "No endpoints found that support',
          'tool use" or the more opaque "No endpoints available matching your guardrail',
          'restrictions and data policy" — neither message says "this model can\'t do tool use",',
          "which is the actual cause.",
          `Pick a different --model — see ${FREE_MODELS_URL} for currently free, tool-capable options.`,
        ].join("\n"),
      };
    case "unknown":
      return {
        action: "warn",
        message: [
          `opencode + openrouter: model "${modelId}" was not found in OpenRouter's public model`,
          "catalog, so its tool-use support could not be verified (it may be new, renamed, or a",
          "router alias without capability metadata). Proceeding without verification — if the",
          'first prompt fails with a tool-use or "guardrail restrictions" error, this unverified',
          "capability is why.",
        ].join("\n"),
      };
    case "lookup-failed":
      return {
        action: "warn",
        message: [
          `opencode + openrouter: could not reach OpenRouter's model catalog to verify "${modelId}"`,
          `supports tool use (${result.error.message}).`,
          "Proceeding without verification — this is a network/lookup failure, NOT evidence the",
          'model lacks tool support. If the first prompt fails with "No endpoints found that',
          'support tool use" or similar, that IS the capability problem this check could not',
          "confirm in advance.",
        ].join("\n"),
      };
  }
}
