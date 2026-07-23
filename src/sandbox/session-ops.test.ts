import { describe, expect, it } from "bun:test";
import { buildIdleNudge, type ClassifiedSession } from "./session-ops";
import type { Classification, SessionWithState } from "./reap";

const NOW = new Date("2026-05-07T12:00:00Z").getTime();

function row(
  name: string,
  classification: Classification,
  lastAttachedAt: string | null,
): ClassifiedSession {
  const meta = {
    id: name,
    name,
    repoPath: "/r",
    image: "i",
    policy: "p",
    createdAt: "2026-05-07T08:00:00Z",
    lastAttachedAt,
    attachedPid: null,
    harness: "claude_code" as const,
  };
  const state: SessionWithState = { ...meta, containerState: "running", pidAlive: false };
  return { meta, classification, state };
}

describe("buildIdleNudge", () => {
  it("returns null when no other idle sessions", () => {
    const rows = [row("self", "idle-recent", null)];
    expect(buildIdleNudge(rows, "self", NOW)).toBeNull();
  });

  it("excludes the current session and lists others with idle age", () => {
    const rows = [
      row("self", "idle-recent", null),
      row("alice-47d2b9", "idle-recent", new Date(NOW - 60 * 60 * 1000).toISOString()),
    ];
    const msg = buildIdleNudge(rows, "self", NOW)!;
    expect(msg).toContain("1 other idle sandbox is running");
    expect(msg).toContain("alice-47d2b9");
    expect(msg).toContain("idle 1h");
    expect(msg).not.toContain("self");
    expect(msg).toContain("openlock stop");
  });

  it("pluralizes and includes idle-stale rows", () => {
    const rows = [
      row("a-1", "idle-recent", new Date(NOW - 3 * 60 * 60 * 1000).toISOString()),
      row("b-2", "idle-stale", new Date(NOW - 60 * 60 * 1000).toISOString()),
    ];
    const msg = buildIdleNudge(rows, "self", NOW)!;
    expect(msg).toContain("2 other idle sandboxes are running");
  });

  it("ignores non-idle classifications", () => {
    const rows = [
      row("attached-1", "attached", null),
      row("exited-1", "exited", null),
      row("missing-1", "missing", null),
    ];
    expect(buildIdleNudge(rows, "self", NOW)).toBeNull();
  });
});
