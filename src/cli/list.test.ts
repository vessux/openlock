import { describe, expect, it } from "bun:test";
import { renderGatewayHeaderForTest, gatewayJsonForTest } from "./list";

describe("renderGatewayHeader", () => {
  it("renders stopped gateway with consistent column positions", () => {
    const out = renderGatewayHeaderForTest({ running: false, pid: null });
    expect(out).toContain("GATEWAY        STATE    PID    RSS       UPTIME");
    expect(out).toContain("stopped");
    // UPTIME column starts at the same offset in header and data row
    const lines = out.split("\n");
    expect(lines[0]!.indexOf("UPTIME")).toBe(lines[1]!.length - 1);
  });

  it("renders running gateway with formatted rss and uptime", () => {
    const out = renderGatewayHeaderForTest({
      running: true,
      pid: 12345,
      rssKb: 42_000,
      uptimeMs: 8_040_000,
    });
    expect(out).toContain("running");
    expect(out).toContain("12345");
    expect(out).toContain("41.0 MB");
    expect(out).toContain("2h 14m");
  });

  it("uses '-' placeholders when running but rss/uptime missing", () => {
    const out = renderGatewayHeaderForTest({ running: true, pid: 999 });
    expect(out).toContain("999");
    expect(out).toContain(" -");
  });
});

describe("gatewayJson", () => {
  it("collapses undefined to null in JSON shape", () => {
    const j = gatewayJsonForTest({ running: true, pid: 7 });
    expect(j).toEqual({
      name: "podman-dev",
      state: "running",
      pid: 7,
      rssKb: null,
      uptimeMs: null,
    });
  });

  it("emits stopped state with all-null fields when not running", () => {
    const j = gatewayJsonForTest({ running: false, pid: null });
    expect(j).toEqual({
      name: "podman-dev",
      state: "stopped",
      pid: null,
      rssKb: null,
      uptimeMs: null,
    });
  });
});
