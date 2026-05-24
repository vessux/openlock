import { describe, expect, it } from "bun:test";
import { parseArgs } from "node:util";
import { flagSchema } from "./sandbox";

describe("sandbox flagSchema", () => {
  it("declares --policy (string) and --help/-h", () => {
    expect(flagSchema.policy).toEqual({ type: "string" });
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });

  it("includes --harness flag", () => {
    expect("harness" in flagSchema).toBe(true);
    const h = (flagSchema as { harness?: { type: string } }).harness;
    expect(h?.type).toBe("string");
  });
});

describe("sandbox flagSchema (extended)", () => {
  it("accepts --provider", () => {
    const { values } = parseArgs({
      args: ["--provider", "openrouter"],
      options: flagSchema,
      allowPositionals: true,
    });
    expect(values.provider).toBe("openrouter");
  });
});
