import { describe, expect, it } from "bun:test";
import { commandExists } from "./command-exists";

describe("commandExists", () => {
  it("returns true for a command present on PATH", () => {
    expect(commandExists("sh")).toBe(true);
  });

  it("returns false for a command that does not exist", () => {
    expect(commandExists("definitely-not-a-real-command-xyz123")).toBe(false);
  });
});
