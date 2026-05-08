import { describe, expect, test } from "bun:test";
import { resolveOpenshellBin } from "./openshell";

describe("resolveOpenshellBin", () => {
  test("uses OPENSHELL_BIN env var first", async () => {
    process.env.OPENSHELL_BIN = "/custom/path/openshell";
    const result = await resolveOpenshellBin();
    expect(result).toEqual({ bin: "/custom/path/openshell", prefix: [] });
    delete process.env.OPENSHELL_BIN;
  });

  test("returns a valid command structure", async () => {
    const saved = process.env.OPENSHELL_BIN;
    delete process.env.OPENSHELL_BIN;
    const result = await resolveOpenshellBin();
    expect(result).toHaveProperty("bin");
    expect(result).toHaveProperty("prefix");
    expect(typeof result.bin).toBe("string");
    expect(Array.isArray(result.prefix)).toBe(true);
    process.env.OPENSHELL_BIN = saved;
  });
});
