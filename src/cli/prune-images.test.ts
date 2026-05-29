import { describe, expect, it } from "bun:test";

describe("pruneImagesCmd dry-run", () => {
  it("exits 0 in dry-run mode", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "prune-images", "--dry-run"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
