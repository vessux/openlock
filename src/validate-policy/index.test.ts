import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validatePolicyYaml, validatePolicyFile, formatErrors } from "./index";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const tmpDir = join(import.meta.dir, "../../.test-tmp");

beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("validatePolicyYaml", () => {
  test("accepts valid YAML", () => {
    const errors = validatePolicyYaml(`
version: 1
process:
  run_as_user: sandbox
  run_as_group: sandbox
filesystem_policy:
  read_only: [/usr, /lib]
  read_write: [/tmp]
network_policies:
  test:
    endpoints:
      - host: api.anthropic.com
        port: 443
`);
    expect(errors).toHaveLength(0);
  });

  test("rejects invalid YAML syntax", () => {
    const errors = validatePolicyYaml("{{invalid yaml");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("YAML parse error");
  });

  test("rejects empty document", () => {
    const errors = validatePolicyYaml("");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("empty");
  });

  test("catches schema + semantic errors", () => {
    const errors = validatePolicyYaml(`
version: 1
process:
  run_as_user: root
`);
    expect(errors.some((e) => e.message.includes("sandbox"))).toBe(true);
  });

  test("rejects unknown fields in YAML", () => {
    const errors = validatePolicyYaml(`
version: 1
network_policies:
  test:
    endpoints:
      - host: example.com
        port: 443
        unknown_field: true
`);
    expect(errors.some((e) => e.message.includes("unknown_field"))).toBe(true);
  });
});

describe("validatePolicyFile", () => {
  test("validates file from disk", () => {
    const path = join(tmpDir, "test.yaml");
    writeFileSync(path, "version: 1\n");
    const errors = validatePolicyFile(path);
    expect(errors).toHaveLength(0);
  });

  test("reports missing file", () => {
    const errors = validatePolicyFile("/nonexistent/policy.yaml");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("cannot read file");
  });
});

describe("formatErrors", () => {
  test("formats with file path", () => {
    const output = formatErrors(
      [{ path: "version", message: "missing" }],
      "test.yaml",
    );
    expect(output).toContain("test.yaml");
    expect(output).toContain("version");
    expect(output).toContain("missing");
  });

  test("returns empty string for no errors", () => {
    expect(formatErrors([])).toBe("");
  });
});
