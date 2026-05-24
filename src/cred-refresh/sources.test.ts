import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import { createSource, EnvSource, FileSource } from "./sources";

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

describe("FileSource", () => {
  let _dir: string;
  let _originalHome: string | undefined;

  beforeEach(() => {
    _dir = mkdtempSync(join(tmpdir(), "openlock-fs-"));
    _originalHome = process.env.HOME;
    process.env.HOME = _dir;
  });
  afterEach(() => {
    if (_originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = _originalHome;
    rmSync(_dir, { recursive: true, force: true });
  });

  it("reads providers.<id>.credentials.<envName> from credentials.json", async () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_API_KEY: "sk-or-v1-x" },
      created_at: "t",
    });
    const src = new FileSource("OPENROUTER_API_KEY", { providerId: "openrouter" });
    expect(await src.resolve()).toBe("sk-or-v1-x");
  });

  it("returns null when the credential is missing", async () => {
    const src = new FileSource("OPENROUTER_API_KEY", { providerId: "openrouter" });
    expect(await src.resolve()).toBeNull();
  });
});

describe("createSource recognizes source: file", () => {
  it("returns a FileSource with type 'file'", () => {
    const s = createSource("OPENROUTER_API_KEY", {
      source: "file",
      provider_id: "openrouter",
    });
    expect(s.type).toBe("file");
  });

  it("throws if provider_id is missing", () => {
    expect(() => createSource("OPENROUTER_API_KEY", { source: "file" })).toThrow(/provider_id/);
  });
});
