import { describe, expect, it } from "bun:test";
import { parseArgs } from "node:util";
import { buildProxyLogCmd, flagSchema } from "./logs";

describe("logs flagSchema", () => {
  it("parses --follow/-f and --lines/-n", () => {
    const { values } = parseArgs({
      args: ["-f", "-n", "50"],
      options: flagSchema,
      allowPositionals: true,
    });
    expect(values.follow).toBe(true);
    expect(values.lines).toBe("50");
  });
});

describe("buildProxyLogCmd", () => {
  it("tails the date-globbed openshell proxy log with default lines", () => {
    const cmd = buildProxyLogCmd();
    expect(cmd[0]).toBe("sh");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toContain("/var/log/openshell.*.log");
    expect(cmd[2]).toContain("-n 200");
    expect(cmd[2]).not.toContain("-f");
  });

  it("adds -f for follow and honors a custom line count", () => {
    expect(buildProxyLogCmd({ follow: true, lines: 25 })[2]).toContain("-n 25 -f");
  });

  it("matches openshell.<date>.log but NOT the openshell-ocsf sibling (literal dot)", () => {
    const script = buildProxyLogCmd()[2];
    expect(script).toMatch(/openshell\.\*\.log/);
    expect(script).not.toContain("openshell-ocsf");
  });

  it("falls back to the default line count for a negative/invalid value", () => {
    expect(buildProxyLogCmd({ lines: -5 })[2]).toContain("-n 200");
  });
});
