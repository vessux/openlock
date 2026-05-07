import { describe, it, expect } from "bun:test";
import { shouldDropOpenshellStderrLine, filterOpenshellStderr } from "./openshell-stderr";

describe("shouldDropOpenshellStderrLine", () => {
  it("drops the literal ssh-255 line", () => {
    expect(shouldDropOpenshellStderrLine("ssh exited with status 255")).toBe(true);
  });

  it("drops a miette-decorated ssh-255 line", () => {
    expect(shouldDropOpenshellStderrLine("  × ssh exited with status 255")).toBe(true);
  });

  it("keeps unrelated stderr", () => {
    expect(shouldDropOpenshellStderrLine("Building image openlock-js")).toBe(false);
    expect(shouldDropOpenshellStderrLine("Error: bundle failed")).toBe(false);
  });

  it("keeps other ssh exit codes", () => {
    expect(shouldDropOpenshellStderrLine("ssh exited with status 1")).toBe(false);
    expect(shouldDropOpenshellStderrLine("ssh exited with status 130")).toBe(false);
  });
});

describe("filterOpenshellStderr", () => {
  it("removes ssh-255 line from a buffered chunk", () => {
    const input = "Building image\nssh exited with status 255\nDone\n";
    expect(filterOpenshellStderr(input)).toBe("Building image\nDone\n");
  });

  it("preserves trailing newline state", () => {
    expect(filterOpenshellStderr("a\nb\n")).toBe("a\nb\n");
  });

  it("preserves a trailing partial line", () => {
    expect(filterOpenshellStderr("a\nb")).toBe("a\nb");
  });

  it("drops a miette block triggered by ssh-255", () => {
    const input = [
      "starting...",
      "Error:",
      "  × ssh exited with status 255",
      "  ╰─▶ connection closed",
      "",
      "next message",
      "",
    ].join("\n");
    const out = filterOpenshellStderr(input);
    expect(out).not.toContain("ssh exited with status 255");
    expect(out).not.toContain("╰─▶ connection closed");
    expect(out).toContain("starting...");
    expect(out).toContain("next message");
  });
});
