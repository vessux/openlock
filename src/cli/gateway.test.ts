import { describe, expect, it } from "bun:test";
import { flagSchema } from "./gateway";

describe("gateway flagSchema", () => {
  it("declares only --help/-h (subcommand is positional)", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
  });
});
