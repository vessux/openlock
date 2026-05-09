import { describe, expect, it } from "bun:test";
import { flagSchema } from "./stop";

describe("stop flagSchema", () => {
  it("declares --all, --stale, --help/-h", () => {
    expect(flagSchema.all).toEqual({ type: "boolean" });
    expect(flagSchema.stale).toEqual({ type: "boolean" });
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });

  it("does NOT declare --copy or --json (those belong to clean/list)", () => {
    expect("copy" in flagSchema).toBe(false);
    expect("json" in flagSchema).toBe(false);
  });
});
