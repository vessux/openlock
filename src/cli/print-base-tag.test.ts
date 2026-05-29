import { describe, expect, it } from "bun:test";

describe("openlock --print-base-tag", () => {
  it("prints a ghcr-qualified base tag and exits 0", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "--print-base-tag"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^ghcr\.io\/vessux\/openlock-base:[0-9a-f]{12}$/);
  });
});
