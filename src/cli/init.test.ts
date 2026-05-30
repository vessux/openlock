import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFolder } from "../config-core";
import { type FolderState, flagSchema, planInit, renderInitFiles, runInit } from "./init";

const S = (c: boolean, p: boolean, cf: boolean): FolderState => ({
  config: c,
  policy: p,
  containerfile: cf,
});

describe("init flagSchema", () => {
  it("declares --force, --harness, --help", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["force", "harness", "help"]);
  });
});

describe("planInit", () => {
  it("fresh when nothing is present", () => {
    expect(planInit(S(false, false, false), false)).toEqual({ kind: "fresh" });
  });

  it("complete when all present and no --force", () => {
    expect(planInit(S(true, true, true), false)).toEqual({ kind: "complete" });
  });

  it("gap-fill writes only the missing files", () => {
    expect(planInit(S(true, false, false), false)).toEqual({
      kind: "gapfill",
      write: ["policy.yaml", "Containerfile"],
      keep: ["config.yaml"],
    });
  });

  it("--force regenerates all three regardless of state", () => {
    expect(planInit(S(true, true, true), true)).toEqual({
      kind: "regenerate",
      write: ["config.yaml", "policy.yaml", "Containerfile"],
    });
  });
});

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "olinit-"));
}

const nonTtyIO = {
  isTTY: false,
  write: (_s: string) => {},
  select: async () => "bind",
  confirm: async () => false,
  prompt: async (_q: string, d = "") => d,
};

describe("renderInitFiles", () => {
  it("returns all three files; Containerfile references the base image", () => {
    const files = renderInitFiles({
      harness: "claude_code",
      workdir: "bind",
      extraMounts: [],
      env: {},
      args: [],
    });
    expect(Object.keys(files).sort()).toEqual(["Containerfile", "config.yaml", "policy.yaml"]);
    expect(files.Containerfile).toContain("FROM ghcr.io/vessux/openlock-base:");
  });
});

describe("runInit (non-interactive)", () => {
  it("fresh non-TTY writes a complete, lint-clean .openlock/", async () => {
    const proj = tmpProject();
    const code = await runInit({
      projectPath: proj,
      force: false,
      harness: "claude_code",
      io: nonTtyIO,
    });
    expect(code).toBe(0);
    const folder = join(proj, ".openlock");
    expect(existsSync(join(folder, "config.yaml"))).toBe(true);
    expect(existsSync(join(folder, "policy.yaml"))).toBe(true);
    expect(existsSync(join(folder, "Containerfile"))).toBe(true);
    expect(lintFolder(proj, { offline: true })).toEqual([]);
  });

  it("gap-fill writes only missing files and leaves existing ones untouched", async () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), "# hand edited\nmounts: []\n");
    const code = await runInit({
      projectPath: proj,
      force: false,
      harness: "claude_code",
      io: nonTtyIO,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(folder, "config.yaml"), "utf-8")).toBe("# hand edited\nmounts: []\n");
    expect(existsSync(join(folder, "policy.yaml"))).toBe(true);
    expect(existsSync(join(folder, "Containerfile"))).toBe(true);
  });

  it("complete folder refuses (writes nothing new)", async () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    for (const f of ["config.yaml", "policy.yaml", "Containerfile"]) {
      writeFileSync(join(folder, f), "x");
    }
    const out: string[] = [];
    const io = { ...nonTtyIO, write: (s: string) => out.push(s) };
    const code = await runInit({ projectPath: proj, force: false, harness: "claude_code", io });
    expect(code).toBe(0);
    expect(out.join("")).toContain("complete");
    expect(readFileSync(join(folder, "config.yaml"), "utf-8")).toBe("x");
  });

  it("--force regenerates all three (lint-clean)", async () => {
    const proj = tmpProject();
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), "stale");
    const code = await runInit({
      projectPath: proj,
      force: true,
      harness: "claude_code",
      io: nonTtyIO,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(folder, "config.yaml"), "utf-8")).not.toBe("stale");
    expect(lintFolder(proj, { offline: true })).toEqual([]);
  });
});

describe("runInit guided (TTY)", () => {
  it("threads guided answers into the scaffold", async () => {
    const proj = tmpProject();
    // entry fork → "guided"; workdir → "git-bundle"; harness → "claude_code";
    // add extra mount? no; add env? no; extra args? "" (none)
    const selects = ["guided", "git-bundle", "claude_code"];
    const confirms = [false, false];
    let si = 0;
    let ci = 0;
    const io = {
      isTTY: true,
      write: (_s: string) => {},
      select: async () => selects[si++],
      confirm: async () => confirms[ci++],
      prompt: async (_q: string, d = "") => d,
    };
    const code = await runInit({ projectPath: proj, force: false, harness: "claude_code", io });
    expect(code).toBe(0);
    const cfg = readFileSync(join(proj, ".openlock", "config.yaml"), "utf-8");
    // git-bundle is the ACTIVE (uncommented, 4-space-indented) workdir type
    expect(cfg).toMatch(/\n {4}type: git-bundle/);
  });
});
