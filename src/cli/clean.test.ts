import { describe, expect, it } from "bun:test";
import { flagSchema } from "./clean";

describe("clean flagSchema", () => {
  it("declares --copy as string", () => {
    expect(flagSchema.copy).toEqual({ type: "string" });
  });

  it("declares --all and --stale as boolean", () => {
    expect(flagSchema.all).toEqual({ type: "boolean" });
    expect(flagSchema.stale).toEqual({ type: "boolean" });
  });

  it("declares --json as boolean", () => {
    expect(flagSchema.json).toEqual({ type: "boolean" });
  });

  it("declares --help with short -h", () => {
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });
});
