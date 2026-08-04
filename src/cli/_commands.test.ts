import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_DESCRIPTIONS, COMMAND_FLAGS, SESSION_COMMANDS } from "./_commands";

// openlock-tuxj: the ORIGINAL version of this test compared COMMAND_FLAGS
// against a hand-typed `expected` array — a second hardcoded list that had
// to be kept in sync with the switch in cli.ts by hand, i.e. exactly the
// drift-prone pattern the bug itself is about (three real, dispatched
// commands — update-base, update-harness, prune-images — silently missing
// from COMMAND_FLAGS/COMMAND_DESCRIPTIONS, and nothing would have caught a
// fourth). Deriving the expected list from cli.ts's actual `case "...":`
// labels instead makes cli.ts's switch the single source of truth this test
// checks against, so the next command added and forgotten here fails loudly.
//
// This is in this test file (rather than _help.ts/_commands.ts) because
// restructuring the switch itself to export its command list as a shared
// constant would touch live dispatch code (process.exit/.then chains, the
// inline login/doctor/gateway parsing) for what should be a test-only guard.
const CLI_PATH = join(import.meta.dir, "..", "cli.ts");
const cliSource = readFileSync(CLI_PATH, "utf-8");

// Every `case "...":` line inside main()'s switch, in file order. Relies on
// cli.ts's consistent one-case-per-line, 4-space-indented style (verified
// against the current file); a reformat that breaks this pattern would make
// the parse under-count, which the sanity-floor test below guards against.
function parseSwitchCommands(source: string): string[] {
  const matches = source.matchAll(/^\s{4}case "([^"]+)":/gm);
  return [...matches].map((m) => m[1] as string);
}

// Commands that ARE real switch cases but must stay OUT of completions,
// --help, and the description map:
const HIDDEN_SWITCH_COMMANDS = [
  // Stubbed — prints "not yet implemented" and exits 1. Not ready for users.
  "echo-server",
  // Internal helper the completion scripts themselves shell out to
  // (`openlock __list-sessions`) to populate session-name completions; it
  // must never appear in its own completion list.
  "__list-sessions",
];

describe("cli.ts switch <-> COMMAND_FLAGS/COMMAND_DESCRIPTIONS drift guard (openlock-tuxj)", () => {
  const switchCommands = parseSwitchCommands(cliSource);
  const publicSwitchCommands = switchCommands.filter((c) => !HIDDEN_SWITCH_COMMANDS.includes(c));

  it("sanity floor: the source parse actually found the switch's known-stable commands", () => {
    // Guards against the parse silently degrading to near-nothing (e.g. a
    // reformat of cli.ts breaking the regex) and the equality checks below
    // passing vacuously because BOTH sides ended up empty/wrong together.
    // These three are foundational, long-standing commands (present since
    // near the project's start) chosen so this doesn't need bumping every
    // time an unrelated command is added or removed — unlike a raw count
    // threshold, which would need re-tuning on every such change.
    for (const anchor of ["sandbox", "list", "validate"]) {
      expect(switchCommands, `parser failed to find known-stable case "${anchor}"`).toContain(
        anchor,
      );
    }
  });

  it("COMMAND_FLAGS has exactly the switch's public (non-hidden) commands", () => {
    expect(Object.keys(COMMAND_FLAGS).sort()).toEqual([...publicSwitchCommands].sort());
  });

  it("COMMAND_DESCRIPTIONS has exactly the switch's public (non-hidden) commands", () => {
    // _commands.ts and _descriptions.ts each declare their own `CommandName`
    // type (keyof their own map); those are only identical today because
    // both maps are hand-kept in sync. This is the runtime half of guarding
    // that — the compile-time half is COMMAND_FLAGS's `satisfies
    // Record<DescriptionCommandName, ...>` constraint in _commands.ts, which
    // catches a missing-from-FLAGS gap; this catches the opposite direction
    // (a FLAGS entry with no matching description) as well as both together
    // drifting from the switch.
    expect(Object.keys(COMMAND_DESCRIPTIONS).sort()).toEqual([...publicSwitchCommands].sort());
  });
});

describe("COMMAND_FLAGS", () => {
  it("every entry is a non-empty schema with --help/-h", () => {
    for (const [name, schema] of Object.entries(COMMAND_FLAGS)) {
      expect(schema.help, `${name} missing --help`).toEqual({
        type: "boolean",
        short: "h",
      });
    }
  });
});

describe("SESSION_COMMANDS", () => {
  it("lists exactly the picker-bearing commands", () => {
    expect([...SESSION_COMMANDS].sort()).toEqual([
      "clean",
      "exec",
      "logs",
      "shell",
      "status",
      "stop",
    ]);
  });
});
