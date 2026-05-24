import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveEndpoint } from "./config";

const tmpDir = join(import.meta.dir, "../../.test-tmp");

function writeYaml(content: string): string {
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, "refresh.yaml");
  writeFileSync(path, content);
  return path;
}

beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("loadConfig", () => {
  test("parses valid config", () => {
    const path = writeYaml(`
interval_secs: 30
providers:
  - name: anthropic
    type: claude
    credentials:
      ANTHROPIC_API_KEY:
        source: env
`);
    const config = loadConfig(path);
    expect(config.interval_secs).toBe(30);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].name).toBe("anthropic");
    expect(config.providers[0].type).toBe("claude");
    expect(config.providers[0].credentials.ANTHROPIC_API_KEY.source).toBe("env");
  });

  test("uses default interval when omitted", () => {
    const path = writeYaml(`
providers:
  - name: test
    type: generic
    credentials:
      KEY:
        source: env
`);
    const config = loadConfig(path);
    expect(config.interval_secs).toBe(60);
  });

  test("throws on missing file", () => {
    expect(() => loadConfig("/nonexistent/path.yaml")).toThrow();
  });

  test("throws on empty providers", () => {
    const path = writeYaml(`
providers: []
`);
    expect(() => loadConfig(path)).toThrow("at least one provider");
  });

  test("throws on provider missing name", () => {
    const path = writeYaml(`
providers:
  - type: claude
    credentials:
      KEY:
        source: env
`);
    expect(() => loadConfig(path)).toThrow("name");
  });

  test("throws on provider missing credentials", () => {
    const path = writeYaml(`
providers:
  - name: test
    type: generic
`);
    expect(() => loadConfig(path)).toThrow("credentials");
  });
});

describe("resolveEndpoint", () => {
  test("uses config endpoint first", () => {
    const result = resolveEndpoint("config:9090");
    expect(result).toBe("config:9090");
  });

  test("falls back to env var", () => {
    process.env.OPENSHELL_ENDPOINT = "env:9090";
    const result = resolveEndpoint(undefined);
    expect(result).toBe("env:9090");
    delete process.env.OPENSHELL_ENDPOINT;
  });

  test("falls back to default", () => {
    delete process.env.OPENSHELL_ENDPOINT;
    const result = resolveEndpoint(undefined);
    expect(result).toBe("localhost:9090");
  });
});

describe("file source", () => {
  test("parses credentials with source: file and provider_id", () => {
    const tmpPath = `/tmp/openlock-cred-cfg-${process.pid}-${Date.now()}.yaml`;
    writeFileSync(
      tmpPath,
      `interval_secs: 60
providers:
  - name: openrouter
    type: openrouter
    credentials:
      OPENROUTER_API_KEY:
        source: file
        provider_id: openrouter
`,
    );
    try {
      const cfg = loadConfig(tmpPath);
      expect(cfg.providers[0].credentials.OPENROUTER_API_KEY.source).toBe("file");
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
});
