import { describe, expect, it } from "bun:test";
import {
  buildHarnessExecArgv,
  buildPodmanChownArgv,
  buildPodmanCpArgv,
  buildPodmanRmArgv,
} from "./container";

describe('buildHarnessExecArgv("claude_code", ...)', () => {
  it("returns the baseline argv when extraArgs and extraEnv are empty", () => {
    expect(buildHarnessExecArgv("claude_code", "sb-foo", [], {})).toEqual([
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
      buildHarnessExecArgv(
        "claude_code",
        "sb-foo",
        ["--plugin-dir", "/sandbox/.openlock/skills"],
        {},
      ),
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
    const argv = buildHarnessExecArgv("claude_code", "sb-foo", [], { FOO: "bar", BAZ: "qux" });
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
    const argv = buildHarnessExecArgv("claude_code", "sb-foo", ["--print"], { FOO: "bar" });
    expect(argv).toContain("FOO=bar");
    expect(argv[argv.length - 2]).toBe("claude");
    expect(argv[argv.length - 1]).toBe("--print");
  });
});

describe("buildHarnessExecArgv", () => {
  it("uses 'claude' binary for claude_code harness", () => {
    expect(buildHarnessExecArgv("claude_code", "sb-foo", [], {})).toEqual([
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

  it("uses 'opencode' binary for opencode harness", () => {
    expect(buildHarnessExecArgv("opencode", "sb-foo", [], {})).toEqual([
      "podman",
      "exec",
      "-it",
      "-u",
      "sandbox",
      "-w",
      "/sandbox/repo",
      "sb-foo",
      "opencode",
    ]);
  });

  it("appends extra args after the harness binary for opencode", () => {
    expect(buildHarnessExecArgv("opencode", "sb-foo", ["run", "hello"], {})).toEqual([
      "podman",
      "exec",
      "-it",
      "-u",
      "sandbox",
      "-w",
      "/sandbox/repo",
      "sb-foo",
      "opencode",
      "run",
      "hello",
    ]);
  });

  it("emits --env flags before container name for both harnesses", () => {
    for (const harness of ["claude_code", "opencode"] as const) {
      const argv = buildHarnessExecArgv(harness, "sb-foo", [], { FOO: "bar" });
      const envIdx = argv.indexOf("--env");
      const containerIdx = argv.indexOf("sb-foo");
      expect(envIdx).toBeGreaterThan(-1);
      expect(envIdx).toBeLessThan(containerIdx);
      expect(argv).toContain("FOO=bar");
    }
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
