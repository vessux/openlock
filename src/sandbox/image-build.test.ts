import { describe, it, expect } from "bun:test";
import { computeImageTag, contextDirForHash } from "./image-build";
import { homedir } from "os";
import { join } from "path";

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
