import { describe, expect, it } from "bun:test";
import { COMMAND_FLAGS, SESSION_COMMANDS } from "../_commands";
import { completionScript as bashScript } from "./bash";
import { completionScript as fishScript } from "./fish";
import { completionScript as zshScript } from "./zsh";

describe("bash completion script", () => {
  it("contains all top-level subcommands", () => {
    const s = bashScript();
    for (const cmd of Object.keys(COMMAND_FLAGS)) {
      expect(s, `bash script missing ${cmd}`).toContain(cmd);
    }
  });

  it("invokes openlock __list-sessions for dynamic session names", () => {
    expect(bashScript()).toContain("openlock __list-sessions");
  });

  it("registers itself with `complete -F`", () => {
    expect(bashScript()).toContain("complete -F _openlock openlock");
  });
});

describe("zsh completion script", () => {
  it("starts with #compdef openlock on line 1", () => {
    const s = zshScript();
    expect(s.split("\n")[0]).toBe("#compdef openlock");
  });

  it("contains all top-level subcommands", () => {
    const s = zshScript();
    for (const cmd of Object.keys(COMMAND_FLAGS)) {
      expect(s, `zsh script missing ${cmd}`).toContain(cmd);
    }
  });

  it("invokes openlock __list-sessions for dynamic session names", () => {
    expect(zshScript()).toContain("openlock __list-sessions");
  });
});

describe("fish completion script", () => {
  it("contains all top-level subcommands", () => {
    const s = fishScript();
    for (const cmd of Object.keys(COMMAND_FLAGS)) {
      expect(s, `fish script missing ${cmd}`).toContain(cmd);
    }
  });

  it("invokes openlock __list-sessions for dynamic session names", () => {
    expect(fishScript()).toContain("openlock __list-sessions");
  });

  it("uses fish complete -c openlock", () => {
    expect(fishScript()).toContain("complete -c openlock");
  });
});

describe("bash completion script accuracy", () => {
  it("includes only that command's actual flags for each session command", () => {
    const s = bashScript();
    for (const cmd of SESSION_COMMANDS) {
      const expectedFlags = Object.keys(COMMAND_FLAGS[cmd]).map((k) => `--${k}`);
      const otherFlags = ["--copy", "--all", "--stale", "--json"].filter(
        (f) => !expectedFlags.includes(f),
      );
      // Each expected flag for this cmd must appear in the script
      for (const f of expectedFlags) {
        expect(s, `bash script missing ${f} for ${cmd}`).toContain(f);
      }
      // Extract this command's case branch (text between `${cmd})` and the next `;;`)
      // and assert no foreign flag bleed inside it. Avoids cross-branch false positives.
      const branchMatch = s.match(new RegExp(`\\b${cmd}\\)([\\s\\S]*?);;`));
      expect(branchMatch, `bash script missing case branch for ${cmd}`).not.toBeNull();
      const branchBody = branchMatch![1]!;
      for (const foreign of otherFlags) {
        expect(branchBody, `bash script has foreign ${foreign} in ${cmd} branch`).not.toContain(
          foreign,
        );
      }
    }
  });
});

describe("zsh completion script accuracy", () => {
  it("includes only that command's actual flags for each session command", () => {
    const s = zshScript();
    for (const cmd of SESSION_COMMANDS) {
      const expectedFlags = Object.keys(COMMAND_FLAGS[cmd]).map((k) => `--${k}`);
      const otherFlags = ["--copy", "--all", "--stale", "--json"].filter(
        (f) => !expectedFlags.includes(f),
      );
      // Each expected flag must appear somewhere in the script
      for (const f of expectedFlags) {
        expect(s, `zsh script missing ${f} for ${cmd}`).toContain(f);
      }
      // Extract this command's case branch (text between `${cmd})` and the next `;;`)
      const branchMatch = s.match(new RegExp(`\\b${cmd}\\)([\\s\\S]*?);;`));
      expect(branchMatch, `zsh script missing case branch for ${cmd}`).not.toBeNull();
      const branchBody = branchMatch![1]!;
      for (const foreign of otherFlags) {
        expect(branchBody, `zsh script has foreign ${foreign} in ${cmd} branch`).not.toContain(
          foreign,
        );
      }
    }
  });

  it("retains #compdef header on line 1", () => {
    expect(zshScript().split("\n")[0]).toBe("#compdef openlock");
  });
});

describe("fish completion script accuracy", () => {
  it("includes only that command's actual flags for each session command", () => {
    const s = fishScript();
    for (const cmd of SESSION_COMMANDS) {
      const expectedFlags = Object.keys(COMMAND_FLAGS[cmd]).map((k) => k);
      const otherFlags = ["copy", "all", "stale", "json"].filter((f) => !expectedFlags.includes(f));
      for (const f of expectedFlags) {
        // fish uses -l <name> (long) registration tied to a specific predicate
        expect(s, `fish script missing -l ${f} for ${cmd}`).toMatch(
          new RegExp(`__openlock_using_subcommand ${cmd}[^"]*"\\s.*-l ${f}\\b`),
        );
      }
      for (const foreign of otherFlags) {
        const pattern = new RegExp(`__openlock_using_subcommand ${cmd}[^"]*"\\s.*-l ${foreign}\\b`);
        expect(s, `fish script has foreign -l ${foreign} on ${cmd}`).not.toMatch(pattern);
      }
    }
  });
});
