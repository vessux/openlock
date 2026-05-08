import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { credentialsPath, readToken, writeToken } from "./tokens";

const testDir = join(import.meta.dir, "../.test-config-openlock");

describe("tokens", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null when credentials.json does not exist", () => {
    const result = readToken(join(testDir, "credentials.json"));
    expect(result).toBeNull();
  });

  it("writes and reads back a token", () => {
    const path = join(testDir, "credentials.json");
    writeToken(path, "test-token-abc");
    const result = readToken(path);
    expect(result).toBe("test-token-abc");
  });

  it("creates parent directories when writing", () => {
    const path = join(testDir, "nested", "dir", "credentials.json");
    writeToken(path, "nested-token");
    expect(readToken(path)).toBe("nested-token");
  });

  it("returns null for malformed JSON", () => {
    const path = join(testDir, "credentials.json");
    Bun.write(path, "not json");
    expect(readToken(path)).toBeNull();
  });

  it("returns null for JSON missing token field", () => {
    const path = join(testDir, "credentials.json");
    Bun.write(path, JSON.stringify({ foo: "bar" }));
    expect(readToken(path)).toBeNull();
  });

  it("credentialsPath returns default path under home", () => {
    const p = credentialsPath();
    expect(p).toContain(".config/openlock/credentials.json");
  });
});
