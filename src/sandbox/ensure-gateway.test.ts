import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGatewayRssKb, spawnDaemonToLog } from "./ensure-gateway";
import { pidAlive } from "./proc";

describe("readGatewayRssKb", () => {
  it("returns a positive integer for a live PID (this test process)", () => {
    const rss = readGatewayRssKb(process.pid);
    expect(rss).not.toBeNull();
    expect(rss).toBeGreaterThan(0);
    expect(Number.isInteger(rss)).toBe(true);
  });

  it("returns null for a guard-violating PID (zero)", () => {
    expect(readGatewayRssKb(0)).toBeNull();
  });

  it("returns null when ps fails for a non-existent PID", () => {
    // Large PID unlikely to exist; reaches `ps` and exercises the
    // non-zero exit-code branch (not just the guard).
    expect(readGatewayRssKb(999_999)).toBeNull();
  });
});

describe("spawnDaemonToLog", () => {
  it("captures stdout and stderr to the log file in append mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-daemon-"));
    const log = join(dir, "out.log");
    try {
      const { pid } = spawnDaemonToLog(["sh", "-c", "echo hello; echo boom 1>&2"], dir, log);
      // Wait for the stub to exit.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && pidAlive(pid)) {
        await Bun.sleep(50);
      }
      expect(pidAlive(pid)).toBe(false);
      const contents = readFileSync(log, "utf-8");
      expect(contents).toContain("hello");
      expect(contents).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends across successive invocations (no truncation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-daemon-"));
    const log = join(dir, "out.log");
    try {
      const first = spawnDaemonToLog(["sh", "-c", "echo first"], dir, log);
      const second = spawnDaemonToLog(["sh", "-c", "echo second"], dir, log);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (pidAlive(first.pid) || pidAlive(second.pid))) {
        await Bun.sleep(50);
      }
      const contents = readFileSync(log, "utf-8");
      expect(contents).toContain("first");
      expect(contents).toContain("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
