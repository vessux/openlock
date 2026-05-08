import { describe, expect, it } from "bun:test";
import { pidAlive } from "./proc";

describe("pidAlive", () => {
  it("returns true for the current process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("returns false for a guaranteed-dead pid", () => {
    expect(pidAlive(2 ** 31 - 2)).toBe(false);
  });

  it("returns false for null/undefined/non-positive input", () => {
    expect(pidAlive(null)).toBe(false);
    expect(pidAlive(undefined)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });

  it("returns false after a child process exits", async () => {
    const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    const pid = p.pid;
    await p.exited;
    await Bun.sleep(50);
    expect(pidAlive(pid)).toBe(false);
  });
});
