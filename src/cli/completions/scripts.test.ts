import { describe, expect, it } from "bun:test";
import { completionScript as bashScript } from "./bash";
import { completionScript as fishScript } from "./fish";
import { completionScript as zshScript } from "./zsh";

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

describe("zsh completion script", () => {
  it("starts with #compdef openlock on line 1", () => {
    const s = zshScript();
    expect(s.split("\n")[0]).toBe("#compdef openlock");
  });

  it("contains all top-level subcommands", () => {
    const s = zshScript();
    for (const cmd of [
      "sandbox",
      "list",
      "status",
      "stop",
      "clean",
      "reap",
      "shell",
      "exec",
      "complete",
    ]) {
      expect(s).toContain(cmd);
    }
  });

  it("invokes openlock __list-sessions for dynamic session names", () => {
    expect(zshScript()).toContain("openlock __list-sessions");
  });
});

describe("fish completion script", () => {
  it("contains all top-level subcommands", () => {
    const s = fishScript();
    for (const cmd of [
      "sandbox",
      "list",
      "status",
      "stop",
      "clean",
      "reap",
      "shell",
      "exec",
      "complete",
    ]) {
      expect(s).toContain(cmd);
    }
  });

  it("invokes openlock __list-sessions for dynamic session names", () => {
    expect(fishScript()).toContain("openlock __list-sessions");
  });

  it("uses fish complete -c openlock", () => {
    expect(fishScript()).toContain("complete -c openlock");
  });
});
