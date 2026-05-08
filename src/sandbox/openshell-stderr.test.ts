import { describe, expect, it } from "bun:test";
import { filterOpenshellStderr, shouldDropOpenshellStderrLine } from "./openshell-stderr";

describe("shouldDropOpenshellStderrLine", () => {
  it("drops the literal ssh-255 line", () => {
    expect(shouldDropOpenshellStderrLine("ssh exited with status 255")).toBe(true);
  });

  it("drops a miette-decorated ssh-255 line", () => {
    expect(shouldDropOpenshellStderrLine("  × ssh exited with status 255")).toBe(true);
  });

  it("drops the new combined miette format with 'exit status:' prefix", () => {
    expect(
      shouldDropOpenshellStderrLine("Error:   × ssh exited with status exit status: 255"),
    ).toBe(true);
  });

  it("keeps other ssh exit codes so real failures still surface", () => {
    expect(shouldDropOpenshellStderrLine("ssh exited with status 1")).toBe(false);
    expect(shouldDropOpenshellStderrLine("ssh exited with status 130")).toBe(false);
    expect(shouldDropOpenshellStderrLine("Error:   × ssh exited with status exit status: 1")).toBe(
      false,
    );
  });

  it("drops OpenSSH client connection-closed message", () => {
    expect(shouldDropOpenshellStderrLine("Connection to sandbox closed by remote host.")).toBe(
      true,
    );
    expect(shouldDropOpenshellStderrLine("Connection to 127.0.0.1 closed by remote host.")).toBe(
      true,
    );
  });

  it("drops OpenSSH client_loop disconnect", () => {
    expect(shouldDropOpenshellStderrLine("client_loop: send disconnect: Broken pipe")).toBe(true);
  });

  it("keeps unrelated stderr", () => {
    expect(shouldDropOpenshellStderrLine("Building image openlock-js")).toBe(false);
    expect(shouldDropOpenshellStderrLine("Error: bundle failed")).toBe(false);
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

  it("drops the full SSH death-rattle block as observed in v0.2.0", () => {
    // Real output captured during /exit on Mac + Lima:
    const input = [
      "No commits to sync.",
      "Gateway stopped (pid 92558).",
      "Connection to sandbox closed by remote host.",
      "client_loop: send disconnect: Broken pipe",
      "Error:   × ssh exited with status exit status: 255",
      "",
    ].join("\n");
    const out = filterOpenshellStderr(input);
    expect(out).toContain("No commits to sync.");
    expect(out).toContain("Gateway stopped (pid 92558).");
    expect(out).not.toContain("Connection to sandbox closed");
    expect(out).not.toContain("client_loop:");
    expect(out).not.toContain("ssh exited with status");
  });
});
