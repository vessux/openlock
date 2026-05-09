import { describe, expect, it } from "bun:test";
import { flagSchema } from "./status";

describe("status flagSchema", () => {
  it("declares --json and --help/-h", () => {
    expect(flagSchema.json).toEqual({ type: "boolean" });
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });
});
