import { describe, expect, it } from "bun:test";
import yaml from "js-yaml";
import { defaultPolicyContent } from "./default-policies";

describe("defaultPolicyContent", () => {
  it("returns the single default policy YAML", () => {
    const content = defaultPolicyContent();
    expect(content).toContain("openlock default sandbox policy");
    expect(content).toContain("npm_packages");
    expect(content).toContain("python_packages");
  });

  it("is deterministic", () => {
    expect(defaultPolicyContent()).toBe(defaultPolicyContent());
  });

  it("allows opencode a read-only models.dev GET endpoint with no cred_inject", () => {
    const doc = yaml.load(defaultPolicyContent()) as {
      network_policies: Record<
        string,
        {
          endpoints?: Array<{
            host: string;
            rules?: Array<{ allow: { method: string; path: string } }>;
            cred_inject?: unknown;
          }>;
        }
      >;
    };
    const endpoints = doc.network_policies.opencode.endpoints ?? [];
    const modelsDev = endpoints.find((e) => e.host === "models.dev");
    expect(modelsDev).toBeDefined();
    expect(modelsDev?.rules).toEqual([{ allow: { method: "GET", path: "/**" } }]);
    // public read-only metadata — no credential injected
    expect(modelsDev?.cred_inject).toBeUndefined();
  });
});
