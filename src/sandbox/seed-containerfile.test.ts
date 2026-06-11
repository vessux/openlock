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

describe("chown after root harness installs (openlock-ef6)", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional Dockerfile ARG syntax
  const CHOWN_LINE = "RUN chown -R ${SANDBOX_UID}:${SANDBOX_GID} /sandbox";
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional Dockerfile ARG syntax
  const USER_SWITCH = "USER ${SANDBOX_UID}:${SANDBOX_GID}";

  it("opencode: chown appears after npm install and before USER switch", () => {
    const out = seedContainerfile({
      harnesses: ["opencode"],
      baseHash: FAKE_HASH,
      baseContent: BASE_CONTENT_FIXTURE,
    });
    expect(out).toContain(CHOWN_LINE);
    const installIdx = out.indexOf("RUN npm install -g opencode-ai@");
    const chownIdx = out.indexOf(CHOWN_LINE);
    const userIdx = out.lastIndexOf(USER_SWITCH);
    expect(installIdx).toBeGreaterThan(-1);
    expect(chownIdx).toBeGreaterThan(installIdx);
    expect(userIdx).toBeGreaterThan(chownIdx);
  });

  it("claude_code: chown appears after npm install and before USER switch", () => {
    const out = seedContainerfile({
      harnesses: ["claude_code"],
      baseHash: FAKE_HASH,
      baseContent: BASE_CONTENT_FIXTURE,
    });
    expect(out).toContain(CHOWN_LINE);
    const installIdx = out.indexOf("RUN npm install -g @anthropic-ai/claude-code@");
    const chownIdx = out.indexOf(CHOWN_LINE);
    const userIdx = out.lastIndexOf(USER_SWITCH);
    expect(installIdx).toBeGreaterThan(-1);
    expect(chownIdx).toBeGreaterThan(installIdx);
    expect(userIdx).toBeGreaterThan(chownIdx);
  });

  it("multi-harness (claude_code+opencode): chown appears after all installs and before USER switch", () => {
    const out = seedContainerfile({
      harnesses: ["claude_code", "opencode"],
      baseHash: FAKE_HASH,
      baseContent: BASE_CONTENT_FIXTURE,
    });
    expect(out).toContain(CHOWN_LINE);
    const lastInstallIdx = Math.max(
      out.indexOf("RUN npm install -g @anthropic-ai/claude-code@"),
      out.indexOf("RUN npm install -g opencode-ai@"),
    );
    const chownIdx = out.indexOf(CHOWN_LINE);
    const userIdx = out.lastIndexOf(USER_SWITCH);
    expect(lastInstallIdx).toBeGreaterThan(-1);
    expect(chownIdx).toBeGreaterThan(lastInstallIdx);
    expect(userIdx).toBeGreaterThan(chownIdx);
  });
});
