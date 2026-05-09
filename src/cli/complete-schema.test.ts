import { describe, expect, it } from "bun:test";
import { flagSchema } from "./complete";

describe("complete flagSchema", () => {
  it("declares only --help/-h (positional is shell name)", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
  });
});
