import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderSeedContainerfile, seedContainerfile } from "./seed-containerfile";

const SNAP_DIR = join(import.meta.dir, "seed-containerfile.snapshots");
const BASE_CONTENT_FIXTURE = "FROM ubuntu:24.04\nRUN echo base\n";
const FAKE_HASH = "abc123def456";

function snap(name: string): string {
  return readFileSync(join(SNAP_DIR, name), "utf-8");
}

describe("seedContainerfile", () => {
  it("matches snapshot for claude_code only", () => {
    const out = seedContainerfile({
      harnesses: ["claude_code"],
      baseHash: FAKE_HASH,
      baseContent: BASE_CONTENT_FIXTURE,
    });
    expect(out).toBe(snap("claude_code.Containerfile"));
  });

  it("matches snapshot for opencode only", () => {
    const out = seedContainerfile({
      harnesses: ["opencode"],
      baseHash: FAKE_HASH,
      baseContent: BASE_CONTENT_FIXTURE,
    });
    expect(out).toBe(snap("opencode.Containerfile"));
  });

  it("matches snapshot for both harnesses", () => {
    const out = seedContainerfile({
      harnesses: ["claude_code", "opencode"],
      baseHash: FAKE_HASH,
      baseContent: BASE_CONTENT_FIXTURE,
    });
    expect(out).toBe(snap("claude_code+opencode.Containerfile"));
  });

  it("throws on empty harness list", () => {
    expect(() =>
      seedContainerfile({ harnesses: [], baseHash: FAKE_HASH, baseContent: BASE_CONTENT_FIXTURE }),
    ).toThrow("at least one harness");
  });

  it("inlines baseContent as commented reference", () => {
    const out = seedContainerfile({
      harnesses: ["claude_code"],
      baseHash: FAKE_HASH,
      baseContent: "FROM ubuntu:24.04\nRUN echo hi\n",
    });
    expect(out).toContain("# FROM ubuntu:24.04");
    expect(out).toContain("# RUN echo hi");
  });

  it("emits FROM line with provided baseHash", () => {
    const out = seedContainerfile({
      harnesses: ["claude_code"],
      baseHash: FAKE_HASH,
      baseContent: BASE_CONTENT_FIXTURE,
    });
    expect(out).toContain(`FROM ghcr.io/vessux/openlock-base:${FAKE_HASH}`);
  });
});

describe("renderSeedContainerfile", () => {
  it("produces a Containerfile that installs the requested harness", () => {
    const out = renderSeedContainerfile("claude_code");
    expect(out).toContain("FROM ghcr.io/vessux/openlock-base:");
    expect(out).toContain("@anthropic-ai/claude-code@");
  });

  it("installs opencode for the opencode harness", () => {
    expect(renderSeedContainerfile("opencode")).toContain("opencode-ai@");
  });
});
