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
});
