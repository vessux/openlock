import { describe, expect, it } from "bun:test";
import type { Issue } from "../config-core";
import { flagSchema, renderIssues, summaryLine } from "./validate";

describe("validate flagSchema", () => {
  it("declares --offline and --help", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help", "offline"]);
  });
});

describe("renderIssues", () => {
  it("prints ok per file when there are no issues", () => {
    expect(renderIssues([])).toEqual(["  config.yaml: ok", "  policy.yaml: ok"]);
  });

  it("groups issues by file and tier with fix lines", () => {
    const issues: Issue[] = [
      {
        file: "config.yaml",
        severity: "error",
        path: "caps",
        message: 'unknown key "caps"',
        fix: 'remove "caps"',
      },
      {
        file: "config.yaml",
        severity: "filesystem",
        path: "mounts[0].source",
        message: "source /x does not exist",
      },
    ];
    const lines = renderIssues(issues);
    expect(lines).toContain("  config.yaml:");
    expect(lines).toContain('    caps: unknown key "caps"');
    expect(lines).toContain('      fix: remove "caps"');
    expect(lines.some((l) => l.includes("[fs] mounts[0].source"))).toBe(true);
    expect(lines).toContain("  policy.yaml: ok");
  });
});

describe("summaryLine", () => {
  it("reports ok per file when clean", () => {
    expect(summaryLine([])).toBe("config.yaml: ok · policy.yaml: ok");
  });

  it("counts issues per file", () => {
    const issues: Issue[] = [
      { file: "config.yaml", severity: "error", path: "a", message: "x" },
      { file: "config.yaml", severity: "filesystem", path: "b", message: "y" },
      { file: "policy.yaml", severity: "error", path: "c", message: "z" },
    ];
    expect(summaryLine(issues)).toBe("config.yaml: 2 issues · policy.yaml: 1 issue");
  });
});
