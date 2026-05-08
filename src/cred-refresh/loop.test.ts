import { describe, expect, test } from "bun:test";
import { hashCredentials, resolveProviderCredentials } from "./loop";
import { EnvSource } from "./sources";

describe("hashCredentials", () => {
  test("same input produces same hash", () => {
    const creds = { KEY1: "val1", KEY2: "val2" };
    expect(hashCredentials(creds)).toBe(hashCredentials(creds));
  });

  test("different values produce different hash", () => {
    const a = hashCredentials({ KEY: "value-a" });
    const b = hashCredentials({ KEY: "value-b" });
    expect(a).not.toBe(b);
  });

  test("key order does not affect hash", () => {
    const a = hashCredentials({ A: "1", B: "2" });
    const b = hashCredentials({ B: "2", A: "1" });
    expect(a).toBe(b);
  });

  test("empty credentials produce consistent hash", () => {
    const a = hashCredentials({});
    const b = hashCredentials({});
    expect(a).toBe(b);
  });
});

describe("resolveProviderCredentials", () => {
  test("resolves all present env vars", async () => {
    process.env.TEST_RESOLVE_A = "val-a";
    process.env.TEST_RESOLVE_B = "val-b";
    const sources = {
      TEST_RESOLVE_A: new EnvSource("TEST_RESOLVE_A"),
      TEST_RESOLVE_B: new EnvSource("TEST_RESOLVE_B"),
    };
    const result = await resolveProviderCredentials(sources);
    expect(result).toEqual({ TEST_RESOLVE_A: "val-a", TEST_RESOLVE_B: "val-b" });
    delete process.env.TEST_RESOLVE_A;
    delete process.env.TEST_RESOLVE_B;
  });

  test("skips credentials that resolve to null", async () => {
    process.env.TEST_RESOLVE_PRESENT = "here";
    delete process.env.TEST_RESOLVE_MISSING;
    const sources = {
      TEST_RESOLVE_PRESENT: new EnvSource("TEST_RESOLVE_PRESENT"),
      TEST_RESOLVE_MISSING: new EnvSource("TEST_RESOLVE_MISSING"),
    };
    const result = await resolveProviderCredentials(sources);
    expect(result).toEqual({ TEST_RESOLVE_PRESENT: "here" });
    delete process.env.TEST_RESOLVE_PRESENT;
  });
});
