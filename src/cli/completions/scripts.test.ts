import { describe, expect, it } from "bun:test";
import { completionScript as bashScript } from "./bash";

describe("bash completion script", () => {
  it("contains all top-level subcommands", () => {
    const s = bashScript();
    for (const cmd of [
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
      "gateway",
      "doctor",
      "update-images",
      "complete",
    ]) {
      expect(s).toContain(cmd);
    }
  });

  it("invokes openlock __list-sessions for dynamic session names", () => {
    expect(bashScript()).toContain("openlock __list-sessions");
  });

  it("registers itself with `complete -F`", () => {
    expect(bashScript()).toContain("complete -F _openlock openlock");
  });
});
