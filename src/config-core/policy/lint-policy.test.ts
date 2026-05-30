import { describe, expect, it } from "bun:test";
import { lintPolicy } from "./index";

describe("lintPolicy", () => {
  it("returns [] for a valid minimal policy", () => {
    expect(lintPolicy("version: 1\n")).toEqual([]);
  });

  it("tags policy issues with file=policy.yaml and severity=error", () => {
    const issues = lintPolicy("filesystem_policy: {}\n"); // missing required version
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.file === "policy.yaml" && i.severity === "error")).toBe(true);
  });
});
