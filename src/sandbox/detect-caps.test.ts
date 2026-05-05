import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { detectCaps, type Cap } from "./detect-caps";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const testDir = join(import.meta.dir, "../../.test-detect-caps");

describe("detectCaps", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns empty for bare directory", () => {
    expect(detectCaps(testDir)).toEqual([]);
  });

  it("detects js from package.json", () => {
    writeFileSync(join(testDir, "package.json"), "{}");
    expect(detectCaps(testDir)).toEqual(["js"]);
  });

  it("detects py from pyproject.toml", () => {
    writeFileSync(join(testDir, "pyproject.toml"), "");
    expect(detectCaps(testDir)).toEqual(["py"]);
  });

  it("detects py from requirements.txt", () => {
    writeFileSync(join(testDir, "requirements.txt"), "");
    expect(detectCaps(testDir)).toEqual(["py"]);
  });

  it("detects py from poetry.lock", () => {
    writeFileSync(join(testDir, "poetry.lock"), "");
    expect(detectCaps(testDir)).toEqual(["py"]);
  });

  it("detects both js and py", () => {
    writeFileSync(join(testDir, "package.json"), "{}");
    writeFileSync(join(testDir, "pyproject.toml"), "");
    expect(detectCaps(testDir)).toEqual(["js", "py"]);
  });

  it("deduplicates py markers", () => {
    writeFileSync(join(testDir, "pyproject.toml"), "");
    writeFileSync(join(testDir, "requirements.txt"), "");
    expect(detectCaps(testDir)).toEqual(["py"]);
  });
});
