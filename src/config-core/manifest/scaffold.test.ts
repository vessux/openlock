import { describe, expect, it } from "bun:test";
import yaml from "js-yaml";
import { lintManifest, parseManifest } from "./index";
import { scaffoldManifest } from "./scaffold";

describe("scaffoldManifest", () => {
  it("persists the chosen harness as a top-level key", () => {
    expect(scaffoldManifest({ workdir: "bind", harness: "opencode" })).toMatch(
      /^harness: opencode$/m,
    );
    expect(scaffoldManifest({ workdir: "bind", harness: "claude_code" })).toMatch(
      /^harness: claude_code$/m,
    );
  });

  it("the persisted harness round-trips through parseManifest", () => {
    const out = scaffoldManifest({ workdir: "bind", harness: "opencode" });
    expect(parseManifest(out, "/tmp").harness).toBe("opencode");
  });

  it("documents harness in the supported-keys header comment", () => {
    expect(scaffoldManifest({ workdir: "bind", harness: "opencode" })).toMatch(
      /Supported keys: harness, mounts, args, env/,
    );
  });

  it("emits a bind workdir mount at /sandbox/repo by default", () => {
    const out = scaffoldManifest({ workdir: "bind", harness: "claude_code" });
    expect(out).toContain("target: /sandbox/repo");
    expect(out).toMatch(/type: bind/);
    // the alternative is present but commented out
    expect(out).toMatch(/#\s*type: git-bundle/);
  });

  it("swaps active/commented when workdir is git-bundle", () => {
    const out = scaffoldManifest({ workdir: "git-bundle", harness: "claude_code" });
    // active workdir line is indented 4 spaces with no leading '#'
    expect(out).toMatch(/\n {4}type: git-bundle/);
    // bind is now the commented alternative
    expect(out).toMatch(/#\s*type: bind/);
  });

  it("renders chosen env and args (quoted so they stay strings)", () => {
    const out = scaffoldManifest({
      workdir: "bind",
      harness: "claude_code",
      env: { FOO: "bar" },
      args: ["--model", "claude-sonnet-4-6"],
    });
    expect(out).toContain('FOO: "bar"');
    expect(out).toContain('- "--model"');
    expect(out).toContain('- "claude-sonnet-4-6"');
  });

  it("quotes env keys that aren't bare-safe identifiers so output stays parseable YAML", () => {
    const out = scaffoldManifest({
      workdir: "bind",
      harness: "claude_code",
      env: { "ODD: KEY": "v", PLAIN: "ok" },
    });
    expect(out).toContain('"ODD: KEY": "v"');
    expect(out).toContain('PLAIN: "ok"'); // bare-safe key left unquoted
    // The whole manifest must still round-trip through the YAML parser.
    const parsed = yaml.load(out) as { env: Record<string, string> };
    expect(parsed.env["ODD: KEY"]).toBe("v");
    expect(parsed.env.PLAIN).toBe("ok");
  });

  it("lints clean for both workdir types (offline)", () => {
    for (const workdir of ["bind", "git-bundle"] as const) {
      const issues = lintManifest(scaffoldManifest({ workdir, harness: "claude_code" }), "/tmp", {
        offline: true,
      });
      expect(issues).toEqual([]);
    }
  });

  it("lints clean with extra mount, env, args incl. numeric/boolean-looking values (offline)", () => {
    const out = scaffoldManifest({
      workdir: "bind",
      harness: "claude_code",
      extraMounts: [
        { source: "./secrets", target: "/sandbox/.openlock/secrets", type: "copy-once" },
        { source: "./shared", target: "/sandbox/.openlock/shared", type: "bind", readOnly: true },
      ],
      env: { FOO: "bar", COUNT: "42", FLAG: "true" },
      args: ["--model", "x", "99"],
    });
    expect(lintManifest(out, "/tmp", { offline: true })).toEqual([]);
    expect(out).toContain("readOnly: true");
  });

  it("quotes extra-mount source/target so odd characters stay valid (offline)", () => {
    const out = scaffoldManifest({
      workdir: "bind",
      harness: "claude_code",
      extraMounts: [{ source: "./a: b", target: "/sandbox/.openlock/x: y", type: "copy-once" }],
    });
    expect(out).toContain('source: "./a: b"');
    expect(lintManifest(out, "/tmp", { offline: true })).toEqual([]);
  });

  it("claude_code empty args scaffold contains claude-sonnet-4-6 example comment", () => {
    const out = scaffoldManifest({ workdir: "bind", harness: "claude_code" });
    expect(out).toContain("claude-sonnet-4-6");
    expect(out).not.toContain("openrouter");
  });

  it("opencode empty args scaffold contains OpenRouter model guidance", () => {
    const out = scaffoldManifest({ workdir: "bind", harness: "opencode" });
    expect(out).toContain("openrouter/nvidia/nemotron-3-super:free");
    expect(out).toContain("small_model");
    expect(out).not.toContain("claude-sonnet-4-6");
  });

  it("opencode non-empty args are rendered verbatim (no per-harness branching)", () => {
    const out = scaffoldManifest({
      workdir: "bind",
      harness: "opencode",
      args: ["--model", "openrouter/nvidia/nemotron-3-super:free"],
    });
    expect(out).toContain('- "--model"');
    expect(out).toContain('- "openrouter/nvidia/nemotron-3-super:free"');
    // no comment block when args are explicitly set
    expect(out).not.toContain("small_model");
  });
});
