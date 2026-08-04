import { describe, expect, it } from "bun:test";
import {
  computeBaseTag,
  detectBaseImageDrift,
  ensureBase,
  GHCR_BASE_PREFIX,
  isOpenlockBaseRef,
  parseFromImage,
} from "./ensure-base";

describe("computeBaseTag", () => {
  it("returns ghcr-qualified tag with sha256[0..12]", () => {
    const tag = computeBaseTag("FROM ubuntu:24.04\n");
    expect(tag).toMatch(/^ghcr\.io\/vessux\/openlock-base:[0-9a-f]{12}$/);
  });

  it("is deterministic", () => {
    expect(computeBaseTag("hello")).toBe(computeBaseTag("hello"));
  });

  it("differs on content change", () => {
    expect(computeBaseTag("a")).not.toBe(computeBaseTag("b"));
  });
});

describe("parseFromImage", () => {
  it("extracts simple FROM", () => {
    expect(parseFromImage("FROM ubuntu:24.04\nRUN x")).toBe("ubuntu:24.04");
  });

  it("extracts FROM with sha256 digest", () => {
    expect(parseFromImage("FROM ubuntu:24.04@sha256:abc123\n")).toBe("ubuntu:24.04@sha256:abc123");
  });

  it("returns ghcr base ref", () => {
    expect(parseFromImage("FROM ghcr.io/vessux/openlock-base:fb2c8e1d4a31\n")).toBe(
      "ghcr.io/vessux/openlock-base:fb2c8e1d4a31",
    );
  });

  it("ignores commented FROM lines", () => {
    expect(parseFromImage("# FROM ubuntu\nFROM ghcr.io/x:1\n")).toBe("ghcr.io/x:1");
  });

  it("ignores indented commented FROM lines", () => {
    expect(parseFromImage("  # FROM ubuntu\nFROM ghcr.io/x:1\n")).toBe("ghcr.io/x:1");
  });

  it("strips multi-stage 'AS stage' suffix", () => {
    expect(parseFromImage("FROM ubuntu:24.04 AS builder\n")).toBe("ubuntu:24.04");
  });

  it("throws when no active FROM", () => {
    expect(() => parseFromImage("# FROM ubuntu\nRUN x")).toThrow(/no active FROM/);
  });
});

describe("isOpenlockBaseRef", () => {
  it("matches openlock-base refs", () => {
    expect(isOpenlockBaseRef("ghcr.io/vessux/openlock-base:abc")).toBe(true);
  });
  it("rejects other refs", () => {
    expect(isOpenlockBaseRef("ubuntu:24.04")).toBe(false);
    expect(isOpenlockBaseRef("ghcr.io/other/image:1")).toBe(false);
  });
});

describe("GHCR_BASE_PREFIX", () => {
  it("is the canonical prefix", () => {
    expect(GHCR_BASE_PREFIX).toBe("ghcr.io/vessux/openlock-base:");
  });
});

describe("detectBaseImageDrift (openlock-x83q)", () => {
  it("reports match when the pinned hash equals the current content's hash", () => {
    const baseContent = "FROM ubuntu:24.04\n";
    const hash = computeBaseTag(baseContent).slice(GHCR_BASE_PREFIX.length);
    const containerfile = `FROM ${GHCR_BASE_PREFIX}${hash}\nARG SANDBOX_UID=60000\n`;
    expect(detectBaseImageDrift(containerfile, baseContent)).toEqual({ kind: "match" });
  });

  it("reports drift when the pinned hash differs from the current content's hash", () => {
    const oldBaseContent = "FROM ubuntu:24.04\n";
    const newBaseContent = "FROM ubuntu:24.04\nRUN apt-get install -y nftables\n";
    const pinnedHash = computeBaseTag(oldBaseContent).slice(GHCR_BASE_PREFIX.length);
    const expectedHash = computeBaseTag(newBaseContent).slice(GHCR_BASE_PREFIX.length);
    const containerfile = `FROM ${GHCR_BASE_PREFIX}${pinnedHash}\n`;
    expect(detectBaseImageDrift(containerfile, newBaseContent)).toEqual({
      kind: "drift",
      pinnedHash,
      expectedHash,
    });
  });

  it("reports custom when the active FROM isn't an openlock-base ref (documented customization path)", () => {
    const containerfile = "# FROM ghcr.io/vessux/openlock-base:abc\nFROM ubuntu:24.04\n";
    expect(detectBaseImageDrift(containerfile, "anything")).toEqual({ kind: "custom" });
  });

  it("reports unparseable when there's no active FROM line, rather than throwing", () => {
    const containerfile = "# FROM ghcr.io/vessux/openlock-base:abc\nRUN echo hi\n";
    expect(detectBaseImageDrift(containerfile, "anything")).toEqual({ kind: "unparseable" });
  });
});

describe("ensureBase flow", () => {
  it("returns existing tag if image present locally", async () => {
    const tag = await ensureBase("FROM x", {
      imageExists: async () => true,
      tryPull: async () => {
        throw new Error("should not pull");
      },
      build: async () => {
        throw new Error("should not build");
      },
    });
    expect(tag).toMatch(/^ghcr\.io\/vessux\/openlock-base:/);
  });

  it("uses pull if image not local and pull succeeds", async () => {
    let pulled = false;
    await ensureBase("FROM x", {
      imageExists: async () => false,
      tryPull: async () => {
        pulled = true;
        return true;
      },
      build: async () => {
        throw new Error("should not build");
      },
    });
    expect(pulled).toBe(true);
  });

  it("falls back to build if pull fails", async () => {
    let built = false;
    await ensureBase("FROM x", {
      imageExists: async () => false,
      tryPull: async () => false,
      build: async () => {
        built = true;
      },
    });
    expect(built).toBe(true);
  });
});
