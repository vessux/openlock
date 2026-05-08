import { describe, expect, it } from "bun:test";
import { readGatewayRssKb } from "./ensure-gateway";

describe("readGatewayRssKb", () => {
  it("returns a positive integer for a live PID (this test process)", () => {
    const rss = readGatewayRssKb(process.pid);
    expect(rss).not.toBeNull();
    expect(rss).toBeGreaterThan(0);
    expect(Number.isInteger(rss)).toBe(true);
  });

  it("returns null for a PID that does not exist", () => {
    // PID 0 / negative are invalid; ps should fail.
    expect(readGatewayRssKb(0)).toBeNull();
  });
});
