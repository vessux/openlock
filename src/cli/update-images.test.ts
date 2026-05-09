import { describe, expect, it } from "bun:test";
import { flagSchema } from "./update-images";

describe("update-images flagSchema", () => {
  it("declares --no-cache and --help/-h", () => {
    expect(flagSchema["no-cache"]).toEqual({ type: "boolean" });
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });
});
