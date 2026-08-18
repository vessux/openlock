import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// openlock-u7ca: this ticket's whole thesis is "the information exists, the
// surface that would show it never runs" — buildBaseImageDriftCheck already
// existed and was still invisible because nothing ever called it outside an
// on-demand `openlock doctor`. Anchoring this guard to the IMPORT of
// announceBaseImageChangeIfNeeded would pass even if the call site in
// main() were deleted (the import alone is dead code, not wiring), so this
// asserts the actual CALL EXPRESSION is present and runs before main()'s
// first flag short-circuit — mirrors _commands.test.ts's approach of
// parsing cli.ts's real source rather than re-deriving a second hardcoded
// expectation.

const CLI_PATH = join(import.meta.dir, "..", "cli.ts");
const cliSource = readFileSync(CLI_PATH, "utf-8");

describe("cli.ts main() invokes announceBaseImageChangeIfNeeded (openlock-u7ca)", () => {
  it("calls announceBaseImageChangeIfNeeded() somewhere in the file", () => {
    expect(cliSource).toMatch(/\bannounceBaseImageChangeIfNeeded\(\)/);
  });

  it("the call happens before the --version short-circuit inside main()", () => {
    const mainStart = cliSource.indexOf("function main(): void {");
    expect(mainStart).toBeGreaterThan(-1);

    const body = cliSource.slice(mainStart);
    const callIdx = body.indexOf("announceBaseImageChangeIfNeeded()");
    const versionCheckIdx = body.indexOf('globalArgs.includes("--version")');

    expect(
      callIdx,
      "announceBaseImageChangeIfNeeded() is not called inside main()",
    ).toBeGreaterThan(-1);
    expect(
      versionCheckIdx,
      "could not locate the --version short-circuit to anchor against",
    ).toBeGreaterThan(-1);
    expect(
      callIdx,
      "announceBaseImageChangeIfNeeded() must run before the --version short-circuit, " +
        "so it fires on every invocation rather than only on commands that happen to reach it",
    ).toBeLessThan(versionCheckIdx);
  });
});
