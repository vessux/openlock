import { describe, expect, it } from "bun:test";
import { parseSubidCount, rangeCoversUid } from "./subuid";

describe("parseSubidCount", () => {
  it("sums counts across the user's ranges", () => {
    const content = "alice:100000:65536\nkovis:100000:65536\nkovis:200000:1000000\n";
    expect(parseSubidCount(content, "kovis")).toBe(65536 + 1000000);
  });
  it("returns 0 when the user has no entry", () => {
    expect(parseSubidCount("alice:100000:65536\n", "kovis")).toBe(0);
  });
  it("ignores malformed lines", () => {
    expect(parseSubidCount("kovis:100000\n# comment\nkovis:100000:65536\n", "kovis")).toBe(65536);
  });
});

describe("rangeCoversUid", () => {
  it("true when count exceeds the uid", () => {
    expect(rangeCoversUid("kovis:100000:65536\n", "kovis", 60000)).toBe(true);
  });
  it("false when count <= uid (the ju2 bug: 999999 in a 65536 range)", () => {
    expect(rangeCoversUid("kovis:100000:65536\n", "kovis", 999999)).toBe(false);
  });
});
