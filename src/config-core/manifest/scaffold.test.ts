import { describe, expect, it } from "bun:test";
import { lintManifest } from "./index";
import { scaffoldManifest } from "./scaffold";

describe("scaffoldManifest", () => {
  it("emits a bind workdir mount at /sandbox/repo by default", () => {
    const out = scaffoldManifest({ workdir: "bind" });
    expect(out).toContain("target: /sandbox/repo");
    expect(out).toMatch(/type: bind/);
    // the alternative is present but commented out
    expect(out).toMatch(/#\s*type: git-bundle/);
  });

  it("swaps active/commented when workdir is git-bundle", () => {
    const out = scaffoldManifest({ workdir: "git-bundle" });
    // active workdir line is indented 4 spaces with no leading '#'
    expect(out).toMatch(/\n {4}type: git-bundle/);
    // bind is now the commented alternative
    expect(out).toMatch(/#\s*type: bind/);
  });

  it("renders chosen env and args", () => {
    const out = scaffoldManifest({
      workdir: "bind",
      env: { FOO: "bar" },
      args: ["--model", "claude-sonnet-4-6"],
    });
    expect(out).toContain("FOO: bar");
    expect(out).toContain("- --model");
    expect(out).toContain("- claude-sonnet-4-6");
  });

  it("lints clean for both workdir types (offline)", () => {
    for (const workdir of ["bind", "git-bundle"] as const) {
      const issues = lintManifest(scaffoldManifest({ workdir }), "/tmp", { offline: true });
      expect(issues).toEqual([]);
    }
  });

  it("lints clean with extra mount, env, args (offline)", () => {
    const out = scaffoldManifest({
      workdir: "bind",
      extraMounts: [
        { source: "./secrets", target: "/sandbox/.openlock/secrets", type: "copy-once" },
      ],
      env: { FOO: "bar" },
      args: ["--model", "x"],
    });
    expect(lintManifest(out, "/tmp", { offline: true })).toEqual([]);
  });
});
