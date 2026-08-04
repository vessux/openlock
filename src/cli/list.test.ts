import { describe, expect, it } from "bun:test";
import type { Classification } from "../sandbox/reap";
import { classificationFlag, gatewayJsonForTest, renderGatewayHeaderForTest } from "./list";

describe("renderGatewayHeader", () => {
  it("renders stopped gateway with consistent column positions", () => {
    const out = renderGatewayHeaderForTest({ running: false, pid: null, port: 18081 });
    expect(out).toContain("GATEWAY        STATE    PID    RSS       UPTIME    DRIVER");
    expect(out).toContain("stopped");
    // DRIVER column starts at the same offset in header and data row
    const lines = out.split("\n");
    expect(lines[0]!.indexOf("DRIVER")).toBe(lines[1]!.length - 1);
  });

  it("renders running gateway with formatted rss and uptime", () => {
    const out = renderGatewayHeaderForTest({
      running: true,
      pid: 12345,
      rssKb: 42_000,
      uptimeMs: 8_040_000,
      port: 18081,
    });
    expect(out).toContain("running");
    expect(out).toContain("12345");
    expect(out).toContain("41.0 MB");
    expect(out).toContain("2h 14m");
  });

  it("uses '-' placeholders when running but rss/uptime missing", () => {
    const out = renderGatewayHeaderForTest({ running: true, pid: 999, port: 18081 });
    expect(out).toContain("999");
    expect(out).toContain(" -");
  });

  // openlock-ox1: the active driver was invisible in every status surface —
  // half the reason a podman/docker gateway mismatch went unnoticed.
  describe("DRIVER column (openlock-ox1)", () => {
    it("shows the recorded driver on a running gateway", () => {
      const out = renderGatewayHeaderForTest({
        running: true,
        pid: 1,
        driver: "docker",
        port: 18081,
      });
      expect(out).toContain("docker");
    });

    it("shows '-' when running but the driver wasn't recorded (legacy gateway)", () => {
      const out = renderGatewayHeaderForTest({ running: true, pid: 1, port: 18081 });
      const dataLine = out.split("\n")[1]!;
      expect(dataLine.trim().endsWith("-")).toBe(true);
    });

    it("shows '-' when the gateway is stopped", () => {
      const out = renderGatewayHeaderForTest({ running: false, pid: null, port: 18081 });
      const dataLine = out.split("\n")[1]!;
      expect(dataLine.trim().endsWith("-")).toBe(true);
    });
  });
});

describe("gatewayJson", () => {
  it("collapses undefined to null in JSON shape", () => {
    const j = gatewayJsonForTest({ running: true, pid: 7, port: 18081 });
    expect(j).toEqual({
      name: "podman-dev",
      state: "running",
      pid: 7,
      rssKb: null,
      uptimeMs: null,
      driver: null,
    });
  });

  it("emits stopped state with all-null fields when not running", () => {
    const j = gatewayJsonForTest({ running: false, pid: null, port: 18081 });
    expect(j).toEqual({
      name: "podman-dev",
      state: "stopped",
      pid: null,
      rssKb: null,
      uptimeMs: null,
      driver: null,
    });
  });

  it("surfaces the recorded driver (openlock-ox1)", () => {
    const j = gatewayJsonForTest({ running: true, pid: 7, driver: "docker", port: 18081 });
    expect(j.driver).toBe("docker");
  });
});

describe("classificationFlag (openlock-vtl: 'openlock list' must show unreachable honestly)", () => {
  it("renders 'unreachable' as its own distinct flag, NOT the 'missing' one", () => {
    const flag = classificationFlag("unreachable");
    expect(flag).toBe("(gateway unreachable)");
    expect(flag).not.toBe("(no container)");
  });

  it("preserves the existing flags for the pre-existing classifications", () => {
    expect(classificationFlag("idle-stale")).toBe("(idle, reapable)");
    expect(classificationFlag("attached")).toBe("(attached)");
    expect(classificationFlag("missing")).toBe("(no container)");
    expect(classificationFlag("idle-recent")).toBe("");
    expect(classificationFlag("exited")).toBe("");
  });

  // Compiler-enforced exhaustiveness (openlock-vtl): if Classification is
  // ever widened again without updating this function, TypeScript fails the
  // build on the `never` branch — this test just documents that the switch
  // covers every current member, so a passing suite plus a passing
  // typecheck together are the real guarantee.
  it("covers every current Classification member", () => {
    const all: Classification[] = [
      "attached",
      "idle-recent",
      "idle-stale",
      "exited",
      "missing",
      "unreachable",
    ];
    for (const c of all) {
      expect(() => classificationFlag(c)).not.toThrow();
    }
  });
});
