import { describe, expect, it } from "bun:test";
import { COMMAND_FLAGS, SESSION_COMMANDS } from "./_commands";

describe("COMMAND_FLAGS", () => {
  it("includes every public command from cli.ts", () => {
    const expected = [
      "sandbox",
      "list",
      "status",
      "stop",
      "clean",
      "reap",
      "shell",
      "exec",
      "cred-refresh",
      "validate-policy",
      "login",
      "logout",
      "providers",
      "gateway",
      "doctor",
      "update-images",
      "complete",
      "refs",
      "report",
    ].sort();
    expect(Object.keys(COMMAND_FLAGS).sort()).toEqual(expected);
  });

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
    expect([...SESSION_COMMANDS].sort()).toEqual(["clean", "exec", "shell", "status", "stop"]);
  });
});
