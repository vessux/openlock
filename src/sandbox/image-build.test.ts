import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../runtime";
import {
  buildImageBuildArgv,
  buildImageExistsArgv,
  computeImageTag,
  contextDirForHash,
  ensureSandbox,
} from "./image-build";

describe("computeImageTag", () => {
  it("returns prefix:hash with 12-char hex hash", () => {
    const tag = computeImageTag("hello world", "openlock-core");
    expect(tag).toMatch(/^openlock-core:[0-9a-f]{12}$/);
  });

  it("is deterministic for same content + prefix", () => {
    const a = computeImageTag("FROM ubuntu", "openlock-core");
    const b = computeImageTag("FROM ubuntu", "openlock-core");
    expect(a).toBe(b);
  });

  it("differs when content differs", () => {
    const a = computeImageTag("FROM ubuntu", "openlock-core");
    const b = computeImageTag("FROM ubuntu\n", "openlock-core");
    expect(a).not.toBe(b);
  });

  it("differs when prefix differs but hash portion is the same", () => {
    const a = computeImageTag("FROM ubuntu", "openlock-core");
    const b = computeImageTag("FROM ubuntu", "openlock-core-js");
    expect(a).not.toBe(b);
    const aHash = a.split(":")[1];
    const bHash = b.split(":")[1];
    expect(aHash).toBe(bHash); // hash depends only on content
  });
});

describe("contextDirForHash", () => {
  it("returns a path under ~/.cache/openlock/build-context", () => {
    const p = contextDirForHash("a1b2c3d4e5f6");
    expect(p).toBe(join(homedir(), ".cache", "openlock", "build-context", "a1b2c3d4e5f6"));
  });
});

describe("buildImageExistsArgv", () => {
  it.each<[Runtime, string[]]>([
    ["podman", ["podman", "image", "exists", "foo:bar"]],
    ["docker", ["docker", "image", "inspect", "foo:bar"]],
  ])("uses correct argv for %s", (runtime, expected) => {
    expect(buildImageExistsArgv(runtime, "foo:bar")).toEqual(expected);
  });
});

describe("buildImageBuildArgv", () => {
  it("podman without no-cache", () => {
    expect(buildImageBuildArgv("podman", "t:1", "/ctx")).toEqual([
      "podman",
      "build",
      "-t",
      "t:1",
      "/ctx",
    ]);
  });
  it("docker without no-cache", () => {
    expect(buildImageBuildArgv("docker", "t:1", "/ctx")).toEqual([
      "docker",
      "build",
      "-t",
      "t:1",
      "/ctx",
    ]);
  });
  it("podman with no-cache", () => {
    expect(buildImageBuildArgv("podman", "t:1", "/ctx", true)).toEqual([
      "podman",
      "build",
      "-t",
      "t:1",
      "--no-cache",
      "/ctx",
    ]);
  });
  it("docker with no-cache", () => {
    expect(buildImageBuildArgv("docker", "t:1", "/ctx", true)).toEqual([
      "docker",
      "build",
      "-t",
      "t:1",
      "--no-cache",
      "/ctx",
    ]);
  });
});

describe("ensureSandbox", () => {
  it("calls ensureBase when FROM starts with openlock-base prefix", async () => {
    let baseEnsured = false;
    const userContent = "FROM ghcr.io/vessux/openlock-base:abc\nRUN echo hi\n";
    await ensureSandbox(userContent, {
      ensureBase: async () => {
        baseEnsured = true;
        return "ghcr.io/vessux/openlock-base:abc";
      },
      imageExists: async () => true,
      build: async () => {
        throw new Error("should not build user tag");
      },
    });
    expect(baseEnsured).toBe(true);
  });

  it("skips ensureBase for third-party FROM", async () => {
    let baseEnsured = false;
    const userContent = "FROM custom-registry.example/img:1\nRUN x\n";
    await ensureSandbox(userContent, {
      ensureBase: async () => {
        baseEnsured = true;
        return "...";
      },
      imageExists: async () => true,
      build: async () => {},
    });
    expect(baseEnsured).toBe(false);
  });

  it("builds when user-tag image not present", async () => {
    let built = false;
    const userContent = "FROM ghcr.io/vessux/openlock-base:abc\n";
    await ensureSandbox(userContent, {
      ensureBase: async () => "ghcr.io/vessux/openlock-base:abc",
      imageExists: async () => false,
      build: async () => {
        built = true;
      },
    });
    expect(built).toBe(true);
  });

  it("returns openlock-sandbox-prefixed tag", async () => {
    const tag = await ensureSandbox("FROM ghcr.io/vessux/openlock-base:abc\n", {
      ensureBase: async () => "ghcr.io/vessux/openlock-base:abc",
      imageExists: async () => true,
      build: async () => {},
    });
    expect(tag).toMatch(/^openlock-sandbox:[0-9a-f]{12}$/);
  });
});
