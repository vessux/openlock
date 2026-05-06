import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { saveSession, loadSession, type SessionMeta } from "./session-store";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

const testDir = join(import.meta.dir, "../../.test-sessions");

describe("session-store", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves and loads session metadata", () => {
    const meta: SessionMeta = {
      name: "test-session",
      path: "/tmp/project",
      caps: ["js"],
      image: "openlock-core-js:abc123def456",
      policy: "policies/default-js.yaml",
      createdAt: "2026-05-03T12:00:00Z",
    };
    saveSession(testDir, meta);
    const loaded = loadSession(testDir, "test-session");
    expect(loaded).toEqual(meta);
  });

  it("returns null for non-existent session", () => {
    expect(loadSession(testDir, "nope")).toBeNull();
  });
});
