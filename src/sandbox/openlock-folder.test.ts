import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenlockFolder } from "./openlock-folder";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "olf-"));
}
function writeComplete(folder: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "config.yaml"), "mounts: []\nargs: []\nenv: {}\n");
  writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
  writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
}

describe("resolveOpenlockFolder", () => {
  it("errors when .openlock/ is absent", () => {
    expect(() => resolveOpenlockFolder(tmpProject())).toThrow(/openlock init/);
  });

  it("errors when a file is missing (incomplete)", () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), "mounts: []\n");
    expect(() => resolveOpenlockFolder(proj)).toThrow(/policy\.yaml|Containerfile|incomplete/);
  });

  it("resolves a complete folder", () => {
    const proj = tmpProject();
    writeComplete(join(proj, ".openlock"));
    const r = resolveOpenlockFolder(proj);
    expect(r.mounts).toEqual([]);
    expect(r.policyPath).toContain("policy.yaml");
  });

  it("surfaces the persisted harness from config.yaml", () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), "harness: opencode\nmounts: []\n");
    writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
    writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
    expect(resolveOpenlockFolder(proj).harness).toBe("opencode");
  });

  it("leaves harness undefined when config.yaml omits it", () => {
    const proj = tmpProject();
    writeComplete(join(proj, ".openlock"));
    expect(resolveOpenlockFolder(proj).harness).toBeUndefined();
  });

  it("rejects a config.yaml with a leftover caps key", () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), "caps: [js]\n");
    writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
    writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
    expect(() => resolveOpenlockFolder(proj)).toThrow(/unknown key "caps"/);
  });
});
