import { describe, expect, it } from "bun:test";
import { flagSchema } from "./doctor";

describe("doctor flagSchema", () => {
  it("declares only --help/-h", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
  });
});
