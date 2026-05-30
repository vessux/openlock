import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistGlobalDefaultTo } from "./persist";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "olg-")), "config.yaml");
}

describe("persistGlobalDefaultTo", () => {
  it("creates the file and writes the key", () => {
    const p = tmpFile();
    persistGlobalDefaultTo(p, "default_runtime", "podman");
    expect(readFileSync(p, "utf-8")).toContain("default_runtime: podman");
  });

  it("replaces an existing key without duplicating it", () => {
    const p = tmpFile();
    writeFileSync(p, "default_runtime: docker\ndefault_harness: opencode\n");
    persistGlobalDefaultTo(p, "default_runtime", "podman");
    const out = readFileSync(p, "utf-8");
    expect(out).toContain("default_runtime: podman");
    expect(out).not.toContain("default_runtime: docker");
    expect(out).toContain("default_harness: opencode");
  });
});
