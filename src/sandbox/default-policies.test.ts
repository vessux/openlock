import { describe, it, expect } from "bun:test";
import { DEFAULT_POLICIES, policyKeyForCaps, defaultPolicyContent } from "./default-policies";

describe("DEFAULT_POLICIES", () => {
  it("contains all 4 cap permutations", () => {
    expect(Object.keys(DEFAULT_POLICIES).sort()).toEqual([
      "default",
      "default-js",
      "default-js-py",
      "default-py",
    ]);
  });

  it("each entry is non-empty YAML", () => {
    for (const [key, content] of Object.entries(DEFAULT_POLICIES)) {
      expect(content.length, key).toBeGreaterThan(0);
    }
  });
});

describe("policyKeyForCaps", () => {
  it("maps caps to keys", () => {
    expect(policyKeyForCaps([])).toBe("default");
    expect(policyKeyForCaps(["js"])).toBe("default-js");
    expect(policyKeyForCaps(["py"])).toBe("default-py");
    expect(policyKeyForCaps(["js", "py"])).toBe("default-js-py");
  });

  it("is sort-invariant", () => {
    expect(policyKeyForCaps(["py", "js"])).toBe("default-js-py");
  });
});

describe("defaultPolicyContent", () => {
  it("returns content for caps", () => {
    expect(defaultPolicyContent(["js"]).length).toBeGreaterThan(0);
    expect(defaultPolicyContent(["js"])).toBe(DEFAULT_POLICIES["default-js"]);
  });
});
