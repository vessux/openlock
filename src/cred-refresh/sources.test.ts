import { describe, test, expect } from "bun:test";
import { EnvSource } from "./sources";

describe("EnvSource", () => {
  test("resolves existing env var", async () => {
    process.env.TEST_CRED_KEY = "test-secret-value";
    const source = new EnvSource("TEST_CRED_KEY");
    const result = await source.resolve();
    expect(result).toBe("test-secret-value");
    delete process.env.TEST_CRED_KEY;
  });

  test("returns null for missing env var", async () => {
    delete process.env.NONEXISTENT_KEY_12345;
    const source = new EnvSource("NONEXISTENT_KEY_12345");
    const result = await source.resolve();
    expect(result).toBeNull();
  });

  test("returns null for empty env var", async () => {
    process.env.EMPTY_CRED_KEY = "";
    const source = new EnvSource("EMPTY_CRED_KEY");
    const result = await source.resolve();
    expect(result).toBeNull();
    delete process.env.EMPTY_CRED_KEY;
  });

  test("uses custom env var name when provided", async () => {
    process.env.CUSTOM_VAR_NAME = "custom-value";
    const source = new EnvSource("CREDENTIAL_KEY", "CUSTOM_VAR_NAME");
    expect(source.envVar).toBe("CUSTOM_VAR_NAME");
    const result = await source.resolve();
    expect(result).toBe("custom-value");
    delete process.env.CUSTOM_VAR_NAME;
  });

  test("type property is 'env'", () => {
    const source = new EnvSource("KEY");
    expect(source.type).toBe("env");
  });
});
