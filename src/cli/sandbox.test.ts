import { describe, expect, it } from "bun:test";
import { flagSchema } from "./sandbox";

describe("sandbox flagSchema", () => {
  it("declares --policy (string) and --help/-h", () => {
    expect(flagSchema.policy).toEqual({ type: "string" });
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });
});
