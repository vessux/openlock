import { describe, expect, it } from "bun:test";
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
});
