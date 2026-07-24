import { describe, expect, it } from "bun:test";
import { categorizeImages, pruneImages } from "./prune-images";

describe("pruneImages outcome", () => {
  const baseOpts = {
    runtime: "podman" as const,
    legacy: false,
    currentBaseTag: "ghcr.io/vessux/openlock-base:current",
  };
  const baseDeps = {
    listTags: async () => ["openlock-sandbox:aaaaaa", "openlock-sandbox:bbbbbb"],
    listActiveSandboxTags: async () => new Set<string>(),
  };

  it("reports only actually-removed tags and collects failures", async () => {
    const result = await pruneImages(
      { ...baseOpts, dryRun: false },
      {
        ...baseDeps,
        // bbbbbb fails to remove (e.g. still referenced by a stopped container).
        remove: async (_rt, tag) => tag !== "openlock-sandbox:bbbbbb",
      },
    );
    expect(result.removed).toEqual(["openlock-sandbox:aaaaaa"]);
    expect(result.failed).toEqual(["openlock-sandbox:bbbbbb"]);
  });

  it("dry-run returns candidates without calling remove", async () => {
    let removeCalled = false;
    const result = await pruneImages(
      { ...baseOpts, dryRun: true },
      {
        ...baseDeps,
        remove: async () => {
          removeCalled = true;
          return true;
        },
      },
    );
    expect(result.removed).toEqual(["openlock-sandbox:aaaaaa", "openlock-sandbox:bbbbbb"]);
    expect(result.failed).toEqual([]);
    expect(removeCalled).toBe(false);
  });
});

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
