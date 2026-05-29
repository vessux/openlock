import { describe, expect, it } from "bun:test";
import { categorizeImages } from "./prune-images";

describe("categorizeImages", () => {
  const all = [
    "openlock-core:abc123",
    "openlock-core-js:def456",
    "openlock-core-py:111222",
    "openlock-core-js-py:333444",
    "openlock-sandbox:aaaaaa",
    "openlock-sandbox:bbbbbb",
    "ghcr.io/vessux/openlock-base:cccccc",
    "ghcr.io/vessux/openlock-base:dddddd",
    "ubuntu:24.04",
  ];

  it("legacy mode identifies core* prefix only", () => {
    const result = categorizeImages(all, {
      legacy: true,
      currentBaseTag: "ghcr.io/vessux/openlock-base:cccccc",
      referencedSandboxTags: new Set(["openlock-sandbox:aaaaaa"]),
    });
    expect(result.toRemove.sort()).toEqual([
      "openlock-core-js-py:333444",
      "openlock-core-js:def456",
      "openlock-core-py:111222",
      "openlock-core:abc123",
    ]);
  });

  it("default mode removes stale sandbox + non-current base tags", () => {
    const result = categorizeImages(all, {
      legacy: false,
      currentBaseTag: "ghcr.io/vessux/openlock-base:cccccc",
      referencedSandboxTags: new Set(["openlock-sandbox:aaaaaa"]),
    });
    expect(result.toRemove.sort()).toEqual([
      "ghcr.io/vessux/openlock-base:dddddd",
      "openlock-sandbox:bbbbbb",
    ]);
  });

  it("never removes unrelated images", () => {
    const result = categorizeImages(all, {
      legacy: false,
      currentBaseTag: "ghcr.io/vessux/openlock-base:cccccc",
      referencedSandboxTags: new Set(),
    });
    expect(result.toRemove).not.toContain("ubuntu:24.04");
  });
});
