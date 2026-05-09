import { describe, expect, it } from "bun:test";
import { flagSchema } from "./validate-policy";

describe("validate-policy flagSchema", () => {
  it("declares only --help/-h", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
  });
});
