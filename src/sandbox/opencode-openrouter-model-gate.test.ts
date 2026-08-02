import { describe, expect, it } from "bun:test";
import {
  checkModelSupportsTools,
  extractModelArg,
  type FetchOpenRouterModels,
  gateOpencodeOpenRouterModel,
  type OpenRouterModelsResponse,
} from "./opencode-openrouter-model-gate";

// openlock-4g1's real culprit: opencode's own default auto-selected this
// image model, which does not support tool use. OpenRouter's own catalog id
// for it is the BARE form (no "openrouter/" prefix) — verified against the
// live 367-entry catalog.
const IMAGE_MODEL_BARE = "google/gemini-3-pro-image-preview";
// ...but a user (and opencode's own auto-select) addresses it through the
// opencode "openrouter" provider, so the string that actually reaches this
// gate in production carries an extra "openrouter/" prefix the catalog id
// does NOT have. This is the exact form that silently defeated the original
// literal-only comparison — it must resolve to the same catalog entry as the
// bare form above.
const IMAGE_MODEL_PREFIXED = `openrouter/${IMAGE_MODEL_BARE}`;

// A tool-capable ordinary model, addressed the way openlock's own scaffold
// (config-core/manifest/scaffold.ts) tells users to write it: prefixed.
const NEMOTRON_PREFIXED = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";
const NEMOTRON_BARE = "nvidia/nemotron-3-super-120b-a12b:free";

// A router alias: unlike ordinary models, OpenRouter's OWN catalog id for
// this one genuinely INCLUDES the "openrouter/" segment. Bare "free" is NOT
// a catalog entry — used below as a regression guard for literal-first
// ordering (stripping before trying the literal would send this one, the
// most common quick-start pick per openlock-4g1's own notes, to "unknown").
const ROUTER_FREE = "openrouter/free";

// Generic non-catalog constant reused by the plain-arg-extraction tests
// below, which don't touch catalog resolution at all.
const TOOL_MODEL_ID = ROUTER_FREE;

const CATALOG: OpenRouterModelsResponse = {
  data: [
    { id: IMAGE_MODEL_BARE, supported_parameters: ["temperature", "top_p"] },
    { id: NEMOTRON_BARE, supported_parameters: ["temperature", "tools", "tool_choice"] },
    { id: ROUTER_FREE, supported_parameters: ["temperature", "tools", "tool_choice"] },
  ],
};

const fetchFixture: FetchOpenRouterModels = async () => CATALOG;
const fetchFails: FetchOpenRouterModels = async () => {
  throw new Error("network down");
};

describe("extractModelArg", () => {
  it("returns undefined when --model is absent", () => {
    expect(extractModelArg([])).toBeUndefined();
    expect(extractModelArg(["--verbose"])).toBeUndefined();
  });

  it("handles the two-token form: --model X", () => {
    expect(extractModelArg(["--model", TOOL_MODEL_ID])).toBe(TOOL_MODEL_ID);
  });

  it("handles the single-token form: --model=X", () => {
    expect(extractModelArg([`--model=${TOOL_MODEL_ID}`])).toBe(TOOL_MODEL_ID);
  });

  it("finds --model among other args, either form", () => {
    expect(extractModelArg(["--verbose", "--model", TOOL_MODEL_ID, "--debug"])).toBe(TOOL_MODEL_ID);
    expect(extractModelArg(["--verbose", `--model=${TOOL_MODEL_ID}`, "--debug"])).toBe(
      TOOL_MODEL_ID,
    );
  });

  it("uses the last occurrence when --model is repeated (either or mixed forms)", () => {
    expect(extractModelArg(["--model", "openrouter/a", "--model", "openrouter/b"])).toBe(
      "openrouter/b",
    );
    expect(extractModelArg([`--model=openrouter/a`, "--model", "openrouter/b"])).toBe(
      "openrouter/b",
    );
  });

  it("does not consume a trailing --model with no value", () => {
    expect(extractModelArg(["--model"])).toBeUndefined();
  });
});

describe("checkModelSupportsTools", () => {
  it("reports supported for the literal-prefix router alias (openrouter/free)", async () => {
    // Regression guard for literal-first ordering: bare "free" is NOT in the
    // fixture catalog, so a strip-before-literal implementation would
    // incorrectly report "unknown" here.
    const result = await checkModelSupportsTools(ROUTER_FREE, fetchFixture);
    expect(result).toEqual({ kind: "supported" });
  });

  it("reports supported for scaffold's own example, in the prefixed form users actually write", async () => {
    const result = await checkModelSupportsTools(NEMOTRON_PREFIXED, fetchFixture);
    expect(result).toEqual({ kind: "supported" });
  });

  it("reports supported for the bare (unprefixed) catalog id too", async () => {
    const result = await checkModelSupportsTools(NEMOTRON_BARE, fetchFixture);
    expect(result).toEqual({ kind: "supported" });
  });

  it("reports unsupported for the real image-model culprit in prefixed form (the case that was silently broken)", async () => {
    const result = await checkModelSupportsTools(IMAGE_MODEL_PREFIXED, fetchFixture);
    expect(result).toEqual({ kind: "unsupported" });
  });

  it("reports unsupported for the real image-model culprit in bare form", async () => {
    const result = await checkModelSupportsTools(IMAGE_MODEL_BARE, fetchFixture);
    expect(result).toEqual({ kind: "unsupported" });
  });

  it("reports unknown when the model id is absent from the catalog", async () => {
    const result = await checkModelSupportsTools("openrouter/does-not-exist", fetchFixture);
    expect(result).toEqual({ kind: "unknown" });
  });

  it("reports lookup-failed (never throws) on a network error", async () => {
    const result = await checkModelSupportsTools(TOOL_MODEL_ID, fetchFails);
    expect(result.kind).toBe("lookup-failed");
    if (result.kind === "lookup-failed") {
      expect(result.error.message).toBe("network down");
    }
  });
});

describe("gateOpencodeOpenRouterModel", () => {
  it("warns but proceeds when no --model is set in args (preserves the in-TUI pick flow)", async () => {
    const gate = await gateOpencodeOpenRouterModel([], fetchFixture);
    expect(gate.action).toBe("warn");
    if (gate.action === "warn") {
      expect(gate.message).toMatch(/no --model set — proceeding/);
      expect(gate.message).toMatch(/google\/gemini-3-pro-image-preview/);
      expect(gate.message).toMatch(/pick a tool-capable model interactively once inside opencode/);
      expect(gate.message).toMatch(/openrouter\.ai\/models\?max_price=0/);
    }
  });

  it("blocks the real culprit written the way a user actually would (prefixed) — the case that was silently broken", async () => {
    const gate = await gateOpencodeOpenRouterModel(["--model", IMAGE_MODEL_PREFIXED], fetchFixture);
    expect(gate.action).toBe("block");
    if (gate.action === "block") {
      expect(gate.message).toMatch(/does not support tool use/);
      expect(gate.message).toMatch(/not an account, auth, or privacy problem/);
      expect(gate.message).toMatch(IMAGE_MODEL_PREFIXED);
    }
  });

  it("blocks the real culprit in bare form too", async () => {
    const gate = await gateOpencodeOpenRouterModel(["--model", IMAGE_MODEL_BARE], fetchFixture);
    expect(gate.action).toBe("block");
    if (gate.action === "block") {
      expect(gate.message).toMatch(/does not support tool use/);
    }
  });

  it("blocks with the real cause when the model lacks tool support (--model= form)", async () => {
    const gate = await gateOpencodeOpenRouterModel(
      [`--model=${IMAGE_MODEL_PREFIXED}`],
      fetchFixture,
    );
    expect(gate.action).toBe("block");
    if (gate.action === "block") {
      expect(gate.message).toMatch(/does not support tool use/);
    }
  });

  it("proceeds for the literal-prefix router alias (openrouter/free) — regression guard for literal-first ordering", async () => {
    const gate = await gateOpencodeOpenRouterModel(["--model", ROUTER_FREE], fetchFixture);
    expect(gate).toEqual({ action: "proceed" });
  });

  it("proceeds for scaffold's own example model, written in the prefixed form it renders", async () => {
    const gate = await gateOpencodeOpenRouterModel(["--model", NEMOTRON_PREFIXED], fetchFixture);
    expect(gate).toEqual({ action: "proceed" });
  });

  it("warns but proceeds when the catalog lookup fails (network down)", async () => {
    const gate = await gateOpencodeOpenRouterModel(["--model", TOOL_MODEL_ID], fetchFails);
    expect(gate.action).toBe("warn");
    if (gate.action === "warn") {
      expect(gate.message).toMatch(/could not reach OpenRouter/);
      expect(gate.message).toMatch(/NOT evidence the/);
    }
  });

  it("warns but proceeds when the model id is unknown to the catalog", async () => {
    const gate = await gateOpencodeOpenRouterModel(
      ["--model", "openrouter/does-not-exist"],
      fetchFixture,
    );
    expect(gate.action).toBe("warn");
    if (gate.action === "warn") {
      expect(gate.message).toMatch(/was not found in OpenRouter's public model/);
    }
  });
});
