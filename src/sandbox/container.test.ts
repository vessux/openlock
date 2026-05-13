import { describe, expect, it } from "bun:test";
import {
  buildClaudeExecArgv,
  buildPodmanChownArgv,
  buildPodmanCpArgv,
  buildPodmanRmArgv,
} from "./container";

describe("buildClaudeExecArgv", () => {
  it("returns the baseline argv when extraArgs and extraEnv are empty", () => {
    expect(buildClaudeExecArgv("sb-foo", [], {})).toEqual([
      "podman",
      "exec",
      "-it",
      "-u",
      "sandbox",
      "-w",
      "/sandbox/repo",
      "sb-foo",
      "claude",
    ]);
  });

  it("appends extra args after `claude`", () => {
    expect(
      buildClaudeExecArgv("sb-foo", ["--plugin-dir", "/sandbox/.openlock/skills"], {}),
    ).toEqual([
      "podman",
      "exec",
      "-it",
      "-u",
      "sandbox",
      "-w",
      "/sandbox/repo",
      "sb-foo",
      "claude",
      "--plugin-dir",
      "/sandbox/.openlock/skills",
    ]);
  });

  it("emits one --env KEY=VALUE per env entry, before container name", () => {
    const argv = buildClaudeExecArgv("sb-foo", [], { FOO: "bar", BAZ: "qux" });
    const envIdx = argv.indexOf("--env");
    expect(envIdx).toBeGreaterThan(-1);
    const containerIdx = argv.indexOf("sb-foo");
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--env") expect(i).toBeLessThan(containerIdx);
    }
    expect(argv).toContain("FOO=bar");
    expect(argv).toContain("BAZ=qux");
  });

  it("combines extraArgs and extraEnv", () => {
    const argv = buildClaudeExecArgv("sb-foo", ["--print"], { FOO: "bar" });
    expect(argv).toContain("FOO=bar");
    expect(argv[argv.length - 2]).toBe("claude");
    expect(argv[argv.length - 1]).toBe("--print");
  });
});

describe("buildPodmanCpArgv", () => {
  it("returns the argv to copy a host path into the container", () => {
    expect(buildPodmanCpArgv("/host/tmp/skills", "sb-foo", "/sandbox/.openlock/")).toEqual([
      "podman",
      "cp",
      "/host/tmp/skills",
      "sb-foo:/sandbox/.openlock/",
    ]);
  });
});

describe("buildPodmanRmArgv", () => {
  it("returns the argv to rm -rf a container path as root", () => {
    expect(buildPodmanRmArgv("sb-foo", "/sandbox/.openlock/skills")).toEqual([
      "podman",
      "exec",
      "-u",
      "root",
      "sb-foo",
      "rm",
      "-rf",
      "/sandbox/.openlock/skills",
    ]);
  });
});

describe("buildPodmanChownArgv", () => {
  it("returns the argv to chown -R sandbox:sandbox a container path as root", () => {
    expect(buildPodmanChownArgv("sb-foo", "/sandbox/.openlock/skills")).toEqual([
      "podman",
      "exec",
      "-u",
      "root",
      "sb-foo",
      "chown",
      "-R",
      "sandbox:sandbox",
      "/sandbox/.openlock/skills",
    ]);
  });
});
