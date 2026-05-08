import { describe, expect, it } from "bun:test";
import { readGatewayRssKb } from "./ensure-gateway";

describe("readGatewayRssKb", () => {
  it("returns a positive integer for a live PID (this test process)", () => {
    const rss = readGatewayRssKb(process.pid);
    expect(rss).not.toBeNull();
    expect(rss).toBeGreaterThan(0);
    expect(Number.isInteger(rss)).toBe(true);
  });

  it("returns null for a guard-violating PID (zero)", () => {
    expect(readGatewayRssKb(0)).toBeNull();
  });

  it("returns null when ps fails for a non-existent PID", () => {
    // Large PID unlikely to exist; reaches `ps` and exercises the
    // non-zero exit-code branch (not just the guard).
    expect(readGatewayRssKb(999_999)).toBeNull();
  });
});
