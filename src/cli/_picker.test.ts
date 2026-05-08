import { describe, expect, it } from "bun:test";
import type { SessionMeta } from "../sandbox/session-store";
import { type PickerIO, pickSession } from "./_picker";

function meta(name: string, repoPath = `/tmp/${name}`): SessionMeta {
  return {
    id: name,
    name,
    repoPath,
    caps: [],
    image: "openlock-sandbox",
    policy: "default",
    createdAt: "2026-05-09T00:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
  };
}

function fakeIO(overrides: Partial<PickerIO> = {}): PickerIO {
  return {
    isTTY: true,
    readLine: async () => null,
    writeStderr: () => {},
    detectFzf: () => false,
    runFzf: async () => null,
    ...overrides,
  };
}

describe("pickSession", () => {
  it("returns null when sessions list is empty", async () => {
    const result = await pickSession([], "stop", fakeIO());
    expect(result).toBeNull();
  });

  it("returns null when not a TTY", async () => {
    const result = await pickSession([meta("a")], "stop", fakeIO({ isTTY: false }));
    expect(result).toBeNull();
  });
});
