import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  // openlock-251
  it("surfaces persisted cpu/memory from config.yaml", () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), 'cpu: "2"\nmemory: "4Gi"\nmounts: []\n');
    writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
    writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
    const r = resolveOpenlockFolder(proj);
    expect(r.cpu).toBe("2");
    expect(r.memory).toBe("4Gi");
  });

  it("leaves cpu/memory undefined when config.yaml omits them (inherit openshell's default)", () => {
    const proj = tmpProject();
    writeComplete(join(proj, ".openlock"));
    const r = resolveOpenlockFolder(proj);
    expect(r.cpu).toBeUndefined();
    expect(r.memory).toBeUndefined();
  });

  it("surfaces declared credentials", () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "config.yaml"),
      "credentials:\n  - name: github\n    values:\n      GITHUB_TOKEN: { from_env: GITHUB_TOKEN }\n",
    );
    writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
    writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
    const res = resolveOpenlockFolder(proj);
    expect(res.credentials).toEqual([
      { name: "github", values: { GITHUB_TOKEN: { from_env: "GITHUB_TOKEN" } } },
    ]);
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

describe("resolveOpenlockFolder config.local.yaml overlay", () => {
  let dir: string;
  function seedFolder(files: Record<string, string>): void {
    const folder = join(dir, ".openlock");
    mkdirSync(folder, { recursive: true });
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(folder, name), body, "utf-8");
  }
  const POLICY = "version: 1\n";
  const CONTAINERFILE = "FROM scratch\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openlock-folder-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns base args when no local file exists", () => {
    seedFolder({
      "config.yaml": "args: [--verbose]\n",
      "policy.yaml": POLICY,
      Containerfile: CONTAINERFILE,
    });
    expect(resolveOpenlockFolder(dir).args).toEqual(["--verbose"]);
  });

  it("appends local args onto base args", () => {
    seedFolder({
      "config.yaml": "args: [--verbose]\n",
      "config.local.yaml": "args: [--model, opus]\n",
      "policy.yaml": POLICY,
      Containerfile: CONTAINERFILE,
    });
    expect(resolveOpenlockFolder(dir).args).toEqual(["--verbose", "--model", "opus"]);
  });

  it("throws with the filename on a config.local.yaml syntax error", () => {
    seedFolder({
      "config.yaml": "args: [--verbose]\n",
      "config.local.yaml": "args: [unterminated\n",
      "policy.yaml": POLICY,
      Containerfile: CONTAINERFILE,
    });
    expect(() => resolveOpenlockFolder(dir)).toThrow(/config\.local\.yaml/);
  });
});
