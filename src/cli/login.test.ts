import { describe, expect, it } from "bun:test";
import { flagSchema } from "./login";

describe("login flagSchema", () => {
  it("declares --provider and --help/-h", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help", "provider"]);
  });
});
