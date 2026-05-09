import { describe, expect, it } from "bun:test";
import { flagSchema } from "./cred-refresh";

describe("cred-refresh flagSchema", () => {
  it("declares --config (with -c short) and --help/-h", () => {
    expect(flagSchema.config).toEqual({ type: "string", short: "c" });
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });
});
