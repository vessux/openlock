import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { resolveOpenlockFolder } from "./openlock-folder";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "openlock-folder-test-"));
}

describe("resolveOpenlockFolder", () => {
  it("first-run creates Containerfile, config, policy", () => {
    const dir = makeProject();
    try {
      const out = resolveOpenlockFolder(dir);
      expect(out.origin).toBe("first-run");
      expect(existsSync(join(dir, ".openlock/Containerfile"))).toBe(true);
      expect(existsSync(join(dir, ".openlock/config.yaml"))).toBe(true);
      expect(existsSync(join(dir, ".openlock/policy.yaml"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restored-containerfile when config + policy exist but Containerfile missing", () => {
    const dir = makeProject();
    try {
      mkdirSync(join(dir, ".openlock"));
      writeFileSync(join(dir, ".openlock/config.yaml"), "args: []\n");
      writeFileSync(join(dir, ".openlock/policy.yaml"), "# test\n");
      const out = resolveOpenlockFolder(dir);
      expect(out.origin).toBe("restored-containerfile");
      expect(existsSync(join(dir, ".openlock/Containerfile"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deprecation warning when config.yaml has caps field", () => {
    const dir = makeProject();
    try {
      mkdirSync(join(dir, ".openlock"));
      writeFileSync(join(dir, ".openlock/config.yaml"), "caps: [js]\n");
      writeFileSync(join(dir, ".openlock/policy.yaml"), "# test\n");
      const out = resolveOpenlockFolder(dir);
      expect(out.deprecations).toContain("caps");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing user-edited Containerfile", () => {
    const dir = makeProject();
    try {
      mkdirSync(join(dir, ".openlock"));
      const customContent = "FROM custom:1\nRUN echo custom\n";
      writeFileSync(join(dir, ".openlock/Containerfile"), customContent);
      writeFileSync(join(dir, ".openlock/config.yaml"), "args: []\n");
      writeFileSync(join(dir, ".openlock/policy.yaml"), "# test\n");
      const out = resolveOpenlockFolder(dir);
      expect(out.origin).toBe("existing");
      const after = readFileSync(join(dir, ".openlock/Containerfile"), "utf-8");
      expect(after).toBe(customContent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config.yaml schema no longer requires caps", () => {
    const dir = makeProject();
    try {
      resolveOpenlockFolder(dir);
      const cfg = yaml.load(readFileSync(join(dir, ".openlock/config.yaml"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(cfg.caps).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
