import { describe, expect, it } from "bun:test";
import { flagSchema } from "./reap";

describe("reap flagSchema", () => {
  it("declares only --help/-h", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
  });
});
