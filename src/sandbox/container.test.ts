import { describe, expect, it } from "bun:test";
import {
  buildHarnessExecArgv,
  buildOpenshellCreateArgv,
  buildOpenshellExecArgv,
  buildSandboxDeleteArgv,
  buildSandboxDownloadArgv,
  buildSandboxEnv,
  buildSandboxExecRootArgv,
  buildSandboxGetArgv,
  buildSandboxListNamesArgv,
  buildSandboxStartArgv,
  buildSandboxStopArgv,
  buildSandboxUploadArgv,
  parseSandboxGetPhase,
  wrapCmdWithEnv,
} from "./container";

const CLI = ["openshell"] as const;

describe("wrapCmdWithEnv", () => {
  it("returns cmd unchanged when env is empty", () => {
    expect(wrapCmdWithEnv(["claude"], {})).toEqual(["claude"]);
  });

  it("prepends `env K=V ...` when env has entries", () => {
    const out = wrapCmdWithEnv(["claude", "--print"], { FOO: "bar", BAZ: "qux" });
    expect(out[0]).toBe("env");
    expect(out).toContain("FOO=bar");
    expect(out).toContain("BAZ=qux");
    // Original cmd tail preserved verbatim, after env pairs.
    expect(out.slice(-2)).toEqual(["claude", "--print"]);
  });

  it("does not shell-escape values (Bun.spawn passes argv literally)", () => {
    const out = wrapCmdWithEnv(["sh"], { KEY: 'value with "spaces" and $shell' });
    expect(out).toContain('KEY=value with "spaces" and $shell');
  });
});

describe("buildOpenshellExecArgv", () => {
  it("routes through `openshell sandbox exec --name X -- cmd`", () => {
    expect(buildOpenshellExecArgv(CLI, "sb-foo", ["/bin/bash"])).toEqual([
      "openshell",
      "sandbox",
      "exec",
      "--name",
      "sb-foo",
      "--",
      "/bin/bash",
    ]);
  });

  it("prepends multi-element cli prefix (e.g. `mise exec -- openshell`)", () => {
    const cli = ["mise", "exec", "--", "openshell"];
    const argv = buildOpenshellExecArgv(cli, "sb-foo", ["ls"]);
    expect(argv.slice(0, 4)).toEqual(["mise", "exec", "--", "openshell"]);
    expect(argv.slice(4, 8)).toEqual(["sandbox", "exec", "--name", "sb-foo"]);
  });

  it("emits --workdir when provided", () => {
    const argv = buildOpenshellExecArgv(CLI, "sb-foo", ["pwd"], { workdir: "/sandbox/repo" });
    const idx = argv.indexOf("--workdir");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("/sandbox/repo");
  });

  it("emits --user when provided", () => {
    const argv = buildOpenshellExecArgv(CLI, "sb-foo", ["whoami"], { user: "root" });
    const idx = argv.indexOf("--user");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("root");
  });

  it("emits --tty when tty=force, --no-tty when tty=off, neither when tty=auto", () => {
    expect(buildOpenshellExecArgv(CLI, "sb-foo", ["ls"], { tty: "force" })).toContain("--tty");
    expect(buildOpenshellExecArgv(CLI, "sb-foo", ["ls"], { tty: "off" })).toContain("--no-tty");
    const auto = buildOpenshellExecArgv(CLI, "sb-foo", ["ls"], { tty: "auto" });
    expect(auto).not.toContain("--tty");
    expect(auto).not.toContain("--no-tty");
  });

  it("never emits raw `podman exec` (regression-proof for openlock-hnp)", () => {
    const argv = buildOpenshellExecArgv(CLI, "sb-foo", ["/bin/bash"], { workdir: "/sandbox/repo" });
    const joined = argv.join(" ");
    expect(joined).not.toMatch(/\bpodman\s+exec\b/);
  });
});

describe('buildHarnessExecArgv("claude_code", ...)', () => {
  it("returns the baseline argv when extraArgs and extraEnv are empty", () => {
    expect(buildHarnessExecArgv(CLI, "claude_code", "sb-foo", [], {})).toEqual([
      "openshell",
      "sandbox",
      "exec",
      "--name",
      "sb-foo",
      "--workdir",
      "/sandbox/repo",
      "--tty",
      "--",
      "claude",
    ]);
  });

  it("appends extra args after `claude`", () => {
    expect(
      buildHarnessExecArgv(
        CLI,
        "claude_code",
        "sb-foo",
        ["--plugin-dir", "/sandbox/.openlock/skills"],
        {},
      ),
    ).toEqual([
      "openshell",
      "sandbox",
      "exec",
      "--name",
      "sb-foo",
      "--workdir",
      "/sandbox/repo",
      "--tty",
      "--",
      "claude",
      "--plugin-dir",
      "/sandbox/.openlock/skills",
    ]);
  });

  it("wraps the harness command in `env K=V ...` when extraEnv has entries", () => {
    const argv = buildHarnessExecArgv(CLI, "claude_code", "sb-foo", [], {
      FOO: "bar",
      BAZ: "qux",
    });
    // After the `--` separator, the first token must be `env`.
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(argv[sepIdx + 1]).toBe("env");
    expect(argv).toContain("FOO=bar");
    expect(argv).toContain("BAZ=qux");
    // Harness binary still last (before any extraArgs).
    expect(argv[argv.length - 1]).toBe("claude");
  });

  it("does NOT wrap with `env` when extraEnv is empty", () => {
    const argv = buildHarnessExecArgv(CLI, "claude_code", "sb-foo", ["--print"], {});
    const sepIdx = argv.indexOf("--");
    expect(argv[sepIdx + 1]).toBe("claude");
  });

  it("combines extraArgs and extraEnv: env wrapper holds, args trail", () => {
    const argv = buildHarnessExecArgv(CLI, "claude_code", "sb-foo", ["--print"], { FOO: "bar" });
    expect(argv).toContain("FOO=bar");
    expect(argv[argv.length - 2]).toBe("claude");
    expect(argv[argv.length - 1]).toBe("--print");
  });
});

describe("buildHarnessExecArgv (harness binary selection)", () => {
  it("uses 'claude' binary for claude_code harness", () => {
    const argv = buildHarnessExecArgv(CLI, "claude_code", "sb-foo", [], {});
    expect(argv[argv.length - 1]).toBe("claude");
  });

  it("uses 'opencode' binary for opencode harness", () => {
    const argv = buildHarnessExecArgv(CLI, "opencode", "sb-foo", [], {});
    expect(argv[argv.length - 1]).toBe("opencode");
  });

  it("appends extra args after the harness binary for opencode", () => {
    const argv = buildHarnessExecArgv(CLI, "opencode", "sb-foo", ["run", "hello"], {});
    expect(argv.slice(-3)).toEqual(["opencode", "run", "hello"]);
  });

  it("places `env K=V` immediately after the `--` separator for both harnesses", () => {
    for (const harness of ["claude_code", "opencode"] as const) {
      const argv = buildHarnessExecArgv(CLI, harness, "sb-foo", [], { FOO: "bar" });
      const sepIdx = argv.indexOf("--");
      expect(argv[sepIdx + 1]).toBe("env");
      expect(argv).toContain("FOO=bar");
    }
  });

  it("never emits raw `podman exec` (regression-proof for openlock-hnp)", () => {
    for (const harness of ["claude_code", "opencode"] as const) {
      const argv = buildHarnessExecArgv(CLI, harness, "sb-foo", [], { FOO: "bar" });
      expect(argv.join(" ")).not.toMatch(/\bpodman\s+exec\b/);
    }
  });
});

describe("buildSandboxGetArgv", () => {
  it("emits `openshell sandbox get <name>`", () => {
    expect(buildSandboxGetArgv(["cli"], "sess")).toEqual(["cli", "sandbox", "get", "sess"]);
  });

  it("supports a multi-element cli prefix", () => {
    expect(buildSandboxGetArgv(["mise", "exec", "--", "openshell"], "sess")).toEqual([
      "mise",
      "exec",
      "--",
      "openshell",
      "sandbox",
      "get",
      "sess",
    ]);
  });
});

describe("parseSandboxGetPhase", () => {
  // openshell sandbox get prints colorized human output, e.g.
  //   \x1b[1m\x1b[36mSandbox:\x1b[39m\x1b[0m
  //     \x1b[2mPhase:\x1b[0m Ready
  // The parser must strip ANSI escapes and locate the `Phase: <state>` line.
  it("returns 'running' for Ready/Running phase", () => {
    expect(parseSandboxGetPhase("  Phase: Ready\n  Revision: 1")).toBe("running");
    expect(parseSandboxGetPhase("  Phase: Running")).toBe("running");
  });
  it("returns 'exited' for Failed/Exited/Stopped/Error phase", () => {
    expect(parseSandboxGetPhase("  Phase: Failed")).toBe("exited");
    expect(parseSandboxGetPhase("  Phase: Exited")).toBe("exited");
    expect(parseSandboxGetPhase("  Phase: Stopped")).toBe("exited");
    // Fork v0.5.0 has no Stopped variant — explicit stop transitions Ready → Error.
    expect(parseSandboxGetPhase("  Phase: Error")).toBe("exited");
  });
  it("returns 'other' when phase is unknown or missing", () => {
    expect(parseSandboxGetPhase("  Phase: Provisioning")).toBe("other");
    expect(parseSandboxGetPhase("no phase here")).toBe("other");
  });
  it("strips ANSI color codes around the Phase label and value", () => {
    const ansi = "\x1b[1m\x1b[36mSandbox:\x1b[39m\x1b[0m\n\n  \x1b[2mPhase:\x1b[0m Ready\n";
    expect(parseSandboxGetPhase(ansi)).toBe("running");
  });
});

describe("buildSandboxDeleteArgv", () => {
  it("emits `openshell sandbox delete <name>`", () => {
    expect(buildSandboxDeleteArgv(["cli"], "sess")).toEqual(["cli", "sandbox", "delete", "sess"]);
  });
});

describe("buildSandboxStopArgv", () => {
  it("emits `openshell sandbox stop <name>`", () => {
    expect(buildSandboxStopArgv(["cli"], "sess")).toEqual(["cli", "sandbox", "stop", "sess"]);
  });
});

describe("buildSandboxStartArgv", () => {
  it("emits `openshell sandbox start <name>`", () => {
    expect(buildSandboxStartArgv(["cli"], "sess")).toEqual(["cli", "sandbox", "start", "sess"]);
  });
});

describe("buildSandboxUploadArgv", () => {
  it("emits `openshell sandbox upload <name> <local> <dest>`", () => {
    expect(buildSandboxUploadArgv(["cli"], "sess", "/host/file", "/sbx/dir")).toEqual([
      "cli",
      "sandbox",
      "upload",
      "sess",
      "/host/file",
      "/sbx/dir",
    ]);
  });
});

describe("buildSandboxDownloadArgv", () => {
  it("emits `openshell sandbox download <name> <sbxpath> <dest>`", () => {
    expect(buildSandboxDownloadArgv(["cli"], "sess", "/sbx/file", "/host/dir")).toEqual([
      "cli",
      "sandbox",
      "download",
      "sess",
      "/sbx/file",
      "/host/dir",
    ]);
  });
});

describe("buildSandboxListNamesArgv", () => {
  it("emits `openshell sandbox list --names`", () => {
    expect(buildSandboxListNamesArgv(["cli"])).toEqual(["cli", "sandbox", "list", "--names"]);
  });
});

describe("buildSandboxExecRootArgv", () => {
  it("forwards cmd after `--` with --user root", () => {
    expect(buildSandboxExecRootArgv(["cli"], "sess", ["rm", "-rf", "/x"])).toEqual([
      "cli",
      "sandbox",
      "exec",
      "--name",
      "sess",
      "--user",
      "root",
      "--",
      "rm",
      "-rf",
      "/x",
    ]);
  });

  it("never emits raw `podman exec` (regression-proof for openlock-hnp)", () => {
    const argv = buildSandboxExecRootArgv(["cli"], "sess", [
      "chown",
      "-R",
      "sandbox:sandbox",
      "/x",
    ]);
    expect(argv.join(" ")).not.toMatch(/\bpodman\s+exec\b/);
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
