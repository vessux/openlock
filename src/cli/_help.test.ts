import { describe, expect, it, spyOn } from "bun:test";
import { printCmdHelp } from "./_help";

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation(((s: string) => {
    lines.push(s);
  }) as never);
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("printCmdHelp", () => {
  it("prints usage line, summary from registry, and each flag", () => {
    const out = captureLog(() =>
      printCmdHelp(
        "stop",
        {
          all: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        "[name]",
      ),
    );
    expect(out).toContain("Usage: openlock stop [name]");
    expect(out).toContain("Stop session containers");
    expect(out).toContain("--all");
    expect(out).toContain("-h, --help");
  });

  it("annotates string-typed flags with <value>", () => {
    const out = captureLog(() =>
      printCmdHelp(
        "clean",
        {
          copy: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        "[name]",
      ),
    );
    expect(out).toContain("--copy <value>");
  });

  it("omits the Flags section when schema is empty", () => {
    const out = captureLog(() => printCmdHelp("doctor", {}, ""));
    expect(out).not.toContain("Flags:");
    expect(out).toContain("Check system health and prerequisites");
  });
});
