import { describe, expect, it } from "bun:test";
import { extractHarnessBlock, HARNESS_SENTINEL, updateContainerfile } from "./update-containerfile";

const FAKE_HASH_OLD = "old123abc456";
const FAKE_HASH_NEW = "new789def012";
const FAKE_BASE = "FROM ubuntu:24.04\nRUN echo hi\n";

function makeSeed(hash: string, harnessBlock: string): string {
  return `# .openlock/Containerfile
FROM ghcr.io/vessux/openlock-base:${hash}

ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000

# ---- Base image (inline reference) ----------------------------------------
# (inline ref omitted)

${HARNESS_SENTINEL}
${harnessBlock}
`;
}

describe("extractHarnessBlock", () => {
  it("returns text after sentinel", () => {
    const block = "USER root\nRUN npm i\n";
    const input = makeSeed(FAKE_HASH_OLD, block);
    expect(extractHarnessBlock(input)).toBe(block);
  });

  it("throws if sentinel missing", () => {
    expect(() => extractHarnessBlock("FROM x\nRUN y\n")).toThrow(/sentinel/);
  });
});

describe("updateContainerfile", () => {
  it("rewrites FROM to new hash while preserving harness block", () => {
    const oldBlock = "USER root\nRUN custom harness install\n";
    const input = makeSeed(FAKE_HASH_OLD, oldBlock);
    const out = updateContainerfile(input, FAKE_HASH_NEW, FAKE_BASE);
    expect(out).toContain(`FROM ghcr.io/vessux/openlock-base:${FAKE_HASH_NEW}`);
    expect(out).not.toContain(FAKE_HASH_OLD);
    expect(out).toContain(oldBlock);
  });

  it("preserves user comments in harness block verbatim", () => {
    const oldBlock = "# my custom comment\nUSER root\nRUN x\n# another\n";
    const input = makeSeed(FAKE_HASH_OLD, oldBlock);
    const out = updateContainerfile(input, FAKE_HASH_NEW, FAKE_BASE);
    expect(out).toContain("# my custom comment");
    expect(out).toContain("# another");
  });

  it("throws when sentinel missing (refuses to clobber)", () => {
    expect(() => updateContainerfile("FROM x\n", FAKE_HASH_NEW, FAKE_BASE)).toThrow(/sentinel/);
  });
});
