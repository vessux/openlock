import { describe, expect, it } from "bun:test";
import { PROVIDER_IDS, PROVIDERS, validateProviderId } from "./registry";

describe("registry", () => {
  it("includes anthropic and openrouter", () => {
    expect(PROVIDER_IDS).toContain("anthropic");
    expect(PROVIDER_IDS).toContain("openrouter");
  });

  it("PROVIDERS has an entry per id", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id]).toBeDefined();
      expect(PROVIDERS[id].id).toBe(id);
    }
  });

  it("every plugin is compatible with at least one harness", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id].compatibleHarnesses.size).toBeGreaterThan(0);
    }
  });
});

describe("validateProviderId", () => {
  it("accepts known ids", () => {
    expect(validateProviderId("anthropic")).toBe("anthropic");
    expect(validateProviderId("openrouter")).toBe("openrouter");
  });

  it("throws on unknown ids, listing allowed", () => {
    expect(() => validateProviderId("openai")).toThrow(/openai/);
    expect(() => validateProviderId("openai")).toThrow(/anthropic, openrouter/);
  });
});
