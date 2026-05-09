import { describe, expect, it } from "bun:test";
import { flagSchema } from "./shell";

describe("shell flagSchema", () => {
  it("declares only --help/-h (no --copy/--all/--stale/--json bleed)", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });
});
