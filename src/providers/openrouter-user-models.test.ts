import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import {
  type FetchOpenRouterUserModels,
  type FetchOpenRouterUserModelsResult,
  getPermittedModels,
  renderProviderModelsResult,
} from "./openrouter-user-models";

let dir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-openrouter-models-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = dir;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(dir, { recursive: true, force: true });
});

function storeOpenrouterKey(): void {
  writeProvider("openrouter", {
    type: "openrouter",
    credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-test" },
    created_at: "t",
  });
}

function okResult(body: unknown): FetchOpenRouterUserModelsResult {
  return { ok: true, status: 200, statusText: "OK", body };
}

// The 5 real routers observed for a live key during this investigation, and
// their real tool-support split (2 support tools, 3 don't) — used as the
// regression guard for "routers are not a safe class" (openlock-p60 req 4).
const PERMITTED_SET_FIXTURE = okResult({
  data: [
    { id: "openrouter/auto", supported_parameters: ["temperature", "tools", "tool_choice"] },
    { id: "openrouter/auto-beta", supported_parameters: ["temperature", "tools", "tool_choice"] },
    { id: "openrouter/fusion", supported_parameters: ["temperature"] },
    { id: "openrouter/pareto-code", supported_parameters: ["temperature"] },
    { id: "openrouter/bodybuilder", supported_parameters: ["temperature"] },
    {
      id: "nvidia/nemotron-3-super-120b-a12b:free",
      supported_parameters: ["temperature", "tools"],
    },
    { id: "mistralai/mistral-small-3.2-24b-instruct:free", supported_parameters: ["temperature"] },
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      supported_parameters: ["temperature", "tools"],
    },
  ],
});

describe("getPermittedModels", () => {
  it("reports unsupported-provider for anthropic (no models/user equivalent)", async () => {
    const fetchUserModels: FetchOpenRouterUserModels = async () => {
      throw new Error("must not be called for an unsupported provider");
    };
    const result = await getPermittedModels("anthropic", fetchUserModels);
    expect(result).toEqual({ kind: "unsupported-provider" });
  });

  it("reports missing-credential when no key is stored for openrouter", async () => {
    const fetchUserModels: FetchOpenRouterUserModels = async () => {
      throw new Error("must not be called with no stored credential");
    };
    const result = await getPermittedModels("openrouter", fetchUserModels);
    expect(result).toEqual({ kind: "missing-credential" });
  });

  it("sends the stored credential verbatim as the Authorization header (Bearer prefix already inline)", async () => {
    storeOpenrouterKey();
    let seenAuthHeader: string | undefined;
    const fetchUserModels: FetchOpenRouterUserModels = async (authHeader) => {
      seenAuthHeader = authHeader;
      return okResult({ data: [] });
    };
    await getPermittedModels("openrouter", fetchUserModels);
    expect(seenAuthHeader).toBe("Bearer sk-or-v1-test");
  });

  it("returns the permitted set with per-entry tools=yes/no, including tool-incapable routers", async () => {
    storeOpenrouterKey();
    const fetchUserModels: FetchOpenRouterUserModels = async () => PERMITTED_SET_FIXTURE;
    const result = await getPermittedModels("openrouter", fetchUserModels);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.models).toHaveLength(8);
    expect(result.models).toContainEqual({ id: "openrouter/auto", toolsSupported: true });
    expect(result.models).toContainEqual({ id: "openrouter/auto-beta", toolsSupported: true });
    // The tool-incapable routers must NOT be reported as supported just
    // because they're routers — this is the "routers are not a safe class"
    // guard (req 4).
    expect(result.models).toContainEqual({ id: "openrouter/fusion", toolsSupported: false });
    expect(result.models).toContainEqual({ id: "openrouter/pareto-code", toolsSupported: false });
    expect(result.models).toContainEqual({ id: "openrouter/bodybuilder", toolsSupported: false });
  });

  it("reports request-failed with the raw message on an ordinary non-200 response", async () => {
    storeOpenrouterKey();
    const fetchUserModels: FetchOpenRouterUserModels = async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: { error: { message: "Invalid API key" } },
    });
    const result = await getPermittedModels("openrouter", fetchUserModels);
    expect(result).toEqual({ kind: "request-failed", status: 401, message: "Invalid API key" });
  });

  it("falls back to the HTTP status line when a non-200 response has no parseable error message", async () => {
    storeOpenrouterKey();
    const fetchUserModels: FetchOpenRouterUserModels = async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      body: undefined,
    });
    const result = await getPermittedModels("openrouter", fetchUserModels);
    expect(result).toEqual({
      kind: "request-failed",
      status: 503,
      message: "503 Service Unavailable",
    });
  });

  it("translates a guardrail-restrictions error into plain allowlist language instead of parroting it", async () => {
    storeOpenrouterKey();
    const fetchUserModels: FetchOpenRouterUserModels = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      body: {
        error: {
          message: "No endpoints available matching your guardrail restrictions and data policy",
        },
      },
    });
    const result = await getPermittedModels("openrouter", fetchUserModels);
    expect(result.kind).toBe("request-failed");
    if (result.kind !== "request-failed") return;
    expect(result.message).toMatch(/not permitted for this key/);
    expect(result.message).toMatch(/not an account or privacy problem/);
    // Still shows the real OpenRouter wording so it's recognizable, just not
    // presented as the whole story.
    expect(result.message).toMatch(/guardrail restrictions and data policy/);
  });
});

describe("renderProviderModelsResult", () => {
  it("names the provider and points at the fix for unsupported-provider", () => {
    const lines = renderProviderModelsResult("anthropic", { kind: "unsupported-provider" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"anthropic"');
    expect(lines[0]).toContain('only supported for provider "openrouter"');
  });

  it("names the provider and points at login for missing-credential", () => {
    const lines = renderProviderModelsResult("openrouter", { kind: "missing-credential" });
    expect(lines[0]).toContain('"openrouter"');
    expect(lines[0]).toContain("openlock login --provider openrouter");
  });

  it("surfaces the HTTP status and message for request-failed", () => {
    const lines = renderProviderModelsResult("openrouter", {
      kind: "request-failed",
      status: 401,
      message: "Invalid API key",
    });
    expect(lines[0]).toContain("HTTP 401");
    expect(lines[0]).toContain("Invalid API key");
  });

  it("renders the permitted set with tools=yes/no per entry, plus a footer explaining the guardrail error", () => {
    const lines = renderProviderModelsResult("openrouter", {
      kind: "ok",
      models: [
        { id: "openrouter/auto", toolsSupported: true },
        { id: "openrouter/fusion", toolsSupported: false },
      ],
    });
    expect(lines).toContain("openrouter/auto  tools=yes");
    expect(lines).toContain("openrouter/fusion  tools=no");
    expect(lines.some((l) => l.includes("2 model(s) permitted"))).toBe(true);
    expect(lines.some((l) => l.includes("guardrail restrictions and data policy"))).toBe(true);
    expect(lines.some((l) => l.includes("not an account or privacy problem"))).toBe(true);
  });

  it("reports zero permitted models plainly rather than an empty table", () => {
    const lines = renderProviderModelsResult("openrouter", { kind: "ok", models: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0 entries");
  });
});
