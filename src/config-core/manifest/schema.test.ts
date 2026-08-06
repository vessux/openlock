import { describe, expect, it } from "bun:test";
import { validateManifestSchema } from "./schema";

describe("validateManifestSchema", () => {
  it("accepts an empty manifest", () => {
    expect(validateManifestSchema({})).toEqual([]);
  });

  it("rejects a non-mapping root", () => {
    const issues = validateManifestSchema([]);
    expect(issues[0]?.message).toMatch(/must be a mapping/);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.file).toBe("config.yaml");
  });

  it("rejects an unknown top-level key", () => {
    const issues = validateManifestSchema({ caps: ["js"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("caps");
    expect(issues[0]?.message).toMatch(/unknown key "caps"/);
  });

  it("rejects mounts that are not a list", () => {
    expect(validateManifestSchema({ mounts: {} })[0]?.message).toMatch(/'mounts' must be a list/);
  });

  it("rejects a mount with an unknown type", () => {
    const issues = validateManifestSchema({
      mounts: [{ source: "s", target: "/sandbox/.openlock/x", type: "nope" }],
    });
    expect(issues[0]?.message).toMatch(/unknown type 'nope'/);
  });

  it("rejects readOnly on a non-bind mount", () => {
    const issues = validateManifestSchema({
      mounts: [{ source: "s", target: "/sandbox/.openlock/x", type: "copy-once", readOnly: true }],
    });
    expect(issues[0]?.message).toMatch(/readOnly is only valid on type: bind/);
  });

  it("rejects a non-boolean readOnly", () => {
    const issues = validateManifestSchema({
      mounts: [{ source: "s", target: "/sandbox/.openlock/x", type: "bind", readOnly: "yes" }],
    });
    expect(issues[0]?.message).toMatch(/readOnly must be a boolean/);
  });

  it("collects errors across multiple mounts", () => {
    const issues = validateManifestSchema({
      mounts: [
        { source: "s", target: "/x", type: "bad1" },
        { source: "s", target: "/y", type: "bad2" },
      ],
    });
    expect(issues).toHaveLength(2);
  });

  it("rejects non-string args entries and non-string env values", () => {
    expect(validateManifestSchema({ args: [1] })[0]?.message).toMatch(
      /'args' must contain only strings/,
    );
    expect(validateManifestSchema({ env: { A: 1 } })[0]?.message).toMatch(/must be a string/);
  });

  it("accepts a valid harness key", () => {
    expect(validateManifestSchema({ harness: "opencode" })).toEqual([]);
    expect(validateManifestSchema({ harness: "claude_code" })).toEqual([]);
  });

  it("rejects an unknown harness value with the allowed list", () => {
    const issues = validateManifestSchema({ harness: "bogus" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("harness");
    expect(issues[0]?.message).toMatch(/bogus/);
    expect(issues[0]?.message).toMatch(/claude_code/);
    expect(issues[0]?.message).toMatch(/opencode/);
  });

  it("rejects a non-string harness", () => {
    expect(validateManifestSchema({ harness: 1 })[0]?.path).toBe("harness");
  });

  // openlock-251: cpu/memory are passed through verbatim to openshell, so
  // schema validation only guards the shape openlock cares about (present,
  // non-empty string) — the actual quantity grammar is openshell's own.
  it("accepts valid cpu/memory keys", () => {
    expect(validateManifestSchema({ cpu: "2" })).toEqual([]);
    expect(validateManifestSchema({ memory: "4Gi" })).toEqual([]);
    expect(validateManifestSchema({ cpu: "500m", memory: "512Mi" })).toEqual([]);
  });

  it("accepts an empty manifest without cpu/memory (absent means inherit openshell's default)", () => {
    expect(validateManifestSchema({})).toEqual([]);
  });

  it("rejects a non-string cpu", () => {
    const issues = validateManifestSchema({ cpu: 2 });
    expect(issues[0]?.path).toBe("cpu");
    expect(issues[0]?.message).toMatch(/'cpu' must be a non-empty string/);
  });

  it("rejects a non-string memory", () => {
    const issues = validateManifestSchema({ memory: 4 });
    expect(issues[0]?.path).toBe("memory");
    expect(issues[0]?.message).toMatch(/'memory' must be a non-empty string/);
  });

  it("rejects an empty-string cpu/memory", () => {
    expect(validateManifestSchema({ cpu: "" })[0]?.path).toBe("cpu");
    expect(validateManifestSchema({ memory: "  " })[0]?.path).toBe("memory");
  });
});

describe("credentials schema", () => {
  const ok = (doc: unknown) => validateManifestSchema(doc);

  it("valid credentials bundle passes", () => {
    const issues = ok({
      credentials: [{ name: "github", values: { GITHUB_TOKEN: { from_env: "GITHUB_TOKEN" } } }],
    });
    expect(issues).toEqual([]);
  });

  it("credentials must be a list", () => {
    const issues = ok({ credentials: { name: "x" } });
    expect(issues.some((i) => i.path === "credentials")).toBe(true);
  });

  it("missing name errors", () => {
    const issues = ok({ credentials: [{ values: { A: { from_env: "A" } } }] });
    expect(issues.some((i) => i.path === "credentials[0].name")).toBe(true);
  });

  it("duplicate name errors", () => {
    const issues = ok({
      credentials: [
        { name: "dup", values: { A: { from_env: "A" } } },
        { name: "dup", values: { B: { from_env: "B" } } },
      ],
    });
    expect(issues.some((i) => i.message.includes("duplicate"))).toBe(true);
    // The second (repeated) entry is the one flagged, not the first.
    expect(issues.some((i) => i.path === "credentials[1].name")).toBe(true);
  });

  it("empty values errors", () => {
    const issues = ok({ credentials: [{ name: "x", values: {} }] });
    expect(issues.some((i) => i.path === "credentials[0].values")).toBe(true);
  });

  it("unknown source key errors (e.g. stray type)", () => {
    const issues = ok({
      credentials: [{ name: "x", type: "generic", values: { A: { from_env: "A" } } }],
    });
    expect(issues.some((i) => i.path === "credentials[0].type")).toBe(true);
  });

  it("non-string from_env errors", () => {
    const issues = ok({ credentials: [{ name: "x", values: { A: { from_env: 5 } } }] });
    expect(issues.some((i) => i.path === "credentials[0].values.A.from_env")).toBe(true);
  });

  it("unknown source-spec key errors, with the updated allowed-list message", () => {
    const issues = ok({ credentials: [{ name: "x", values: { A: { stored: true } } }] });
    const issue = issues.find((i) => i.path === "credentials[0].values.A.stored");
    expect(issue?.message).toBe('unknown source key "stored" (allowed: from_env, literal)');
  });

  it("valid literal source passes", () => {
    const issues = ok({
      credentials: [
        {
          name: "anthropic-meta",
          values: { ANTHROPIC_BETA: { literal: "code-execution-2025-01-01" } },
        },
      ],
    });
    expect(issues).toEqual([]);
  });

  it("both from_env and literal present errors, distinctly from either alone", () => {
    const issues = ok({
      credentials: [{ name: "x", values: { A: { from_env: "X", literal: "Y" } } }],
    });
    const issue = issues.find((i) => i.path === "credentials[0].values.A");
    expect(issue?.message).toMatch(/exactly one of 'from_env' or 'literal', not both/);
  });

  it("neither from_env nor literal present errors", () => {
    const issues = ok({ credentials: [{ name: "x", values: { A: {} } }] });
    const issue = issues.find((i) => i.path === "credentials[0].values.A");
    expect(issue?.message).toMatch(/must declare one of 'from_env' or 'literal'/);
  });

  it("empty-string literal errors", () => {
    const issues = ok({ credentials: [{ name: "x", values: { A: { literal: "" } } }] });
    expect(issues.some((i) => i.path === "credentials[0].values.A.literal")).toBe(true);
  });

  it("credential entry that is not a mapping errors", () => {
    const issues = ok({ credentials: ["foo"] });
    expect(issues.some((i) => i.path === "credentials[0]")).toBe(true);
    expect(issues.some((i) => i.message.includes("must be a mapping"))).toBe(true);
  });

  it("per-source non-mapping errors", () => {
    const issues = ok({ credentials: [{ name: "x", values: { A: 5 } }] });
    expect(issues.some((i) => i.path === "credentials[0].values.A")).toBe(true);
  });

  it("multiple valid entries pass", () => {
    const issues = ok({
      credentials: [
        { name: "github", values: { GITHUB_TOKEN: { from_env: "GITHUB_TOKEN" } } },
        { name: "npm", values: { NPM_TOKEN: { from_env: "NPM_TOKEN" } } },
      ],
    });
    expect(issues).toEqual([]);
  });
});
