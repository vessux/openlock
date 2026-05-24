import { describe, expect, it } from "bun:test";
import {
  buildHarnessExecArgv,
  buildOpenshellCreateArgv,
  buildPodmanChownArgv,
  buildPodmanCpArgv,
  buildPodmanRmArgv,
  buildSandboxEnv,
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

describe("buildSandboxEnv (provider placeholders)", () => {
  it("injects OPENROUTER_API_KEY placeholder when provider=openrouter, harness=opencode", () => {
    const env = buildSandboxEnv({
      providerId: "openrouter",
      harness: "opencode",
      repoConfigEnv: {},
    });
    expect(env.OPENROUTER_API_KEY).toBe("managed-by-openlock-do-not-leak");
  });

  it("does NOT inject anthropic placeholder for claude_code (OAuth-bearer flow)", () => {
    const env = buildSandboxEnv({
      providerId: "anthropic",
      harness: "claude_code",
      repoConfigEnv: {},
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("injects ANTHROPIC_API_KEY placeholder for opencode+anthropic", () => {
    const env = buildSandboxEnv({
      providerId: "anthropic",
      harness: "opencode",
      repoConfigEnv: {},
    });
    expect(env.ANTHROPIC_API_KEY).toBe("managed-by-openlock-do-not-leak");
  });

  it("repo-config env wins over placeholder when user explicitly sets the same key", () => {
    const env = buildSandboxEnv({
      providerId: "openrouter",
      harness: "opencode",
      repoConfigEnv: { OPENROUTER_API_KEY: "user-explicitly-set" },
    });
    expect(env.OPENROUTER_API_KEY).toBe("user-explicitly-set");
  });
});

describe("buildOpenshellCreateArgv", () => {
  const base = {
    sessionName: "s",
    imageTag: "img",
    uploadDir: "/tmp/staging",
    policy: "/tmp/policy.yaml",
    providerId: "anthropic" as const,
    command: ["/bin/bash"],
  };

  it("emits no --volume when volumeArgs is empty/absent", () => {
    const argv = buildOpenshellCreateArgv(base);
    expect(argv).not.toContain("--volume");
  });

  it("passes providerId verbatim as --provider", () => {
    const argv = buildOpenshellCreateArgv({ ...base, providerId: "openrouter" });
    const idx = argv.indexOf("--provider");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("openrouter");
  });

  it("emits --volume args verbatim when provided", () => {
    const argv = buildOpenshellCreateArgv({
      ...base,
      volumeArgs: ["--volume", "/host:/sandbox/repo", "--volume", "/cache:/home/sandbox/.cache:ro"],
    });
    const idx = argv.indexOf("--volume");
    expect(idx).toBeGreaterThan(-1);
    expect(argv.slice(idx, idx + 4)).toEqual([
      "--volume",
      "/host:/sandbox/repo",
      "--volume",
      "/cache:/home/sandbox/.cache:ro",
    ]);
  });
});
