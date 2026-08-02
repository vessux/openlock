import { afterEach, describe, expect, it, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSandboxNotExited,
  buildExecCmdArgv,
  buildHarnessExecArgv,
  buildOpenshellCreateArgv,
  buildOpenshellExecArgv,
  buildSandboxDeleteArgv,
  buildSandboxDownloadArgv,
  buildSandboxEnv,
  buildSandboxExecRootArgv,
  buildSandboxGetArgv,
  buildSandboxLogsArgv,
  buildSandboxStartArgv,
  buildSandboxStopArgv,
  buildSandboxUploadArgv,
  formatSandboxExitedError,
  getSandboxState,
  harnessEnvFor,
  parseSandboxGetPhase,
  TETHER_STDIO,
  waitForSandboxReady,
  wrapCmdWithEnv,
} from "./container";

const CLI = ["openshell"] as const;

describe("TETHER_STDIO (openlock-sqw regression guard)", () => {
  // The container tether outlives the CLI; if it inherits stdout, a detached
  // create (`openlock sandbox --no-attach`) hangs any piped/CI stdout capture
  // after the CLI process.exit()s. Tripwire against re-`inherit`ing it.
  it("never inherits the CLI's stdout/stderr", () => {
    expect(TETHER_STDIO.stdout).not.toBe("inherit");
    expect(TETHER_STDIO.stderr).not.toBe("inherit");
  });

  it("ignores stdin (no parent stdin held)", () => {
    expect(TETHER_STDIO.stdin).toBe("ignore");
  });
});

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

describe("buildExecCmdArgv (openlock-04x)", () => {
  it("routes through buildOpenshellExecArgv unchanged when extraEnv is empty", () => {
    expect(buildExecCmdArgv(CLI, "sb-foo", ["echo", "hi"])).toEqual([
      "openshell",
      "sandbox",
      "exec",
      "--name",
      "sb-foo",
      "--workdir",
      "/sandbox/repo",
      "--",
      "echo",
      "hi",
    ]);
  });

  // This is the exact defect openlock-04x reported: `openlock exec <s> --
  // claude -p ...` ran with NO env injection at all, unlike the attach path
  // (buildHarnessExecArgv above), because execCmd called buildOpenshellExecArgv
  // directly and never wrapCmdWithEnv. buildExecCmdArgv now always wraps, so
  // exec and attach can't drift apart on this again.
  it("wraps the command in `env K=V ...` when extraEnv has entries, same as the attach path", () => {
    const argv = buildExecCmdArgv(CLI, "sb-foo", ["claude", "-p", "hi"], {
      CLAUDE_CONFIG_DIR: "/sandbox/.openlock/claude-config",
    });
    const dashIdx = argv.indexOf("--");
    expect(argv.slice(dashIdx + 1)).toEqual([
      "env",
      "CLAUDE_CONFIG_DIR=/sandbox/.openlock/claude-config",
      "claude",
      "-p",
      "hi",
    ]);
  });
});

describe("harnessEnvFor (openlock-04x)", () => {
  it("sets CLAUDE_CONFIG_DIR for claude_code", () => {
    expect(harnessEnvFor("claude_code")).toEqual({
      CLAUDE_CONFIG_DIR: "/sandbox/.openlock/claude-config",
    });
  });

  it("is empty for opencode (doesn't read CLAUDE_CONFIG_DIR)", () => {
    expect(harnessEnvFor("opencode")).toEqual({});
  });

  // openlock-1ho: pi otherwise makes startup network calls (pi.dev version
  // check, telemetry, provider-catalog refresh) the default policy doesn't
  // allowlist; PI_OFFLINE disables all of it. harnessEnvFor was a binary
  // ternary on claude_code before this, so this is also a regression guard
  // for a 3rd harness silently getting {} the way a ternary would produce.
  it("sets PI_OFFLINE=1 for pi", () => {
    expect(harnessEnvFor("pi")).toEqual({ PI_OFFLINE: "1" });
  });

  it("buildSandboxEnv (attach path) and buildExecCmdArgv (exec path) agree on claude_code's env, by construction", () => {
    // Regression guard for the actual openlock-04x defect: both paths must
    // derive CLAUDE_CONFIG_DIR from the SAME function, not two copies that
    // can silently drift. This doesn't just assert equal values — it asserts
    // buildSandboxEnv's own harness-keyed slice against harnessEnvFor for
    // all harnesses.
    for (const harness of ["claude_code", "opencode", "pi"] as const) {
      const env = buildSandboxEnv({ providerId: "anthropic", harness, repoConfigEnv: {} });
      expect(env.CLAUDE_CONFIG_DIR).toBe(harnessEnvFor(harness).CLAUDE_CONFIG_DIR);
    }
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

  it("uses 'pi' binary for pi harness", () => {
    const argv = buildHarnessExecArgv(CLI, "pi", "sb-foo", [], {});
    expect(argv[argv.length - 1]).toBe("pi");
  });

  it("appends extra args after the harness binary for opencode", () => {
    const argv = buildHarnessExecArgv(CLI, "opencode", "sb-foo", ["run", "hello"], {});
    expect(argv.slice(-3)).toEqual(["opencode", "run", "hello"]);
  });

  it("places `env K=V` immediately after the `--` separator for all harnesses", () => {
    for (const harness of ["claude_code", "opencode", "pi"] as const) {
      const argv = buildHarnessExecArgv(CLI, harness, "sb-foo", [], { FOO: "bar" });
      const sepIdx = argv.indexOf("--");
      expect(argv[sepIdx + 1]).toBe("env");
      expect(argv).toContain("FOO=bar");
    }
  });

  it("never emits raw `podman exec` (regression-proof for openlock-hnp)", () => {
    for (const harness of ["claude_code", "opencode", "pi"] as const) {
      const argv = buildHarnessExecArgv(CLI, harness, "sb-foo", [], { FOO: "bar" });
      expect(argv.join(" ")).not.toMatch(/\bpodman\s+exec\b/);
    }
  });
});

describe("buildSandboxGetArgv", () => {
  // openlock-gr1: structured JSON, not the colorized human table — confirmed
  // via `openshell sandbox get --help` on the pinned fork build that
  // `sandbox get` itself supports -o/--output (table|yaml|json), so this is
  // the narrower call vs. `sandbox list -o json` + a name filter.
  it("emits `openshell sandbox get <name> --output json`", () => {
    expect(buildSandboxGetArgv(["cli"], "sess")).toEqual([
      "cli",
      "sandbox",
      "get",
      "sess",
      "--output",
      "json",
    ]);
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
      "--output",
      "json",
    ]);
  });
});

describe("parseSandboxGetPhase", () => {
  // openlock-gr1: openshell sandbox get --output json prints a plain (no
  // ANSI) JSON object with a top-level "phase" field carrying the
  // human-readable label (verified against the pinned fork's own
  // sandbox_detail_to_json_includes_policy_fields unit test — see the
  // function's doc comment). Real values: Unspecified | Provisioning |
  // Ready | Error | Deleting | Stopped | Unknown. There is no "Running",
  // "Failed", or "Exited" — those never occur on the wire.
  it("returns 'running' for phase Ready", () => {
    expect(parseSandboxGetPhase('{"phase":"Ready","revision":1}')).toBe("running");
  });
  // Error is the real failure phase (the previous regex-based parser never
  // matched it at all, silently misclassifying it as "other" — openlock-gr1
  // fixes that as a side effect of moving to structured JSON).
  it("returns 'exited' for phase Error", () => {
    expect(parseSandboxGetPhase('{"phase":"Error"}')).toBe("exited");
  });
  // Stopped is split out from exited (openlock-weo): it's the intentional,
  // resumable result of `openlock stop`, not a real failure — callers that
  // just issued an explicit Start need to tell the two apart.
  it("returns 'stopped' for phase Stopped, distinct from Error", () => {
    expect(parseSandboxGetPhase('{"phase":"Stopped"}')).toBe("stopped");
  });
  it("returns 'other' (keep polling) for phases that are legitimately still-coming-up or indeterminate", () => {
    expect(parseSandboxGetPhase('{"phase":"Provisioning"}')).toBe("other");
    expect(parseSandboxGetPhase('{"phase":"Unspecified"}')).toBe("other");
    // Unknown deliberately stays "other" (openlock-ddd): the driver
    // genuinely couldn't determine state, which isn't proof of death, so
    // keep-polling remains the safe read.
    expect(parseSandboxGetPhase('{"phase":"Unknown"}')).toBe("other");
  });
  // openlock-ddd: Deleting is terminal (never reaches Ready) but not a
  // failure — split out from "other" so waitForSandboxReady can fail fast
  // with an accurate message instead of polling a doomed sandbox to the full
  // timeout budget.
  it("returns 'deleting' for phase Deleting, distinct from the keep-polling 'other' bucket", () => {
    expect(parseSandboxGetPhase('{"phase":"Deleting"}')).toBe("deleting");
  });
  it("returns 'other' on unparseable or phase-less output rather than throwing", () => {
    expect(parseSandboxGetPhase("not json at all")).toBe("other");
    expect(parseSandboxGetPhase("{}")).toBe("other");
    expect(parseSandboxGetPhase("")).toBe("other");
  });
});

describe("buildSandboxLogsArgv", () => {
  it("emits top-level `openshell logs <name> -n <lines>` (NOT `sandbox logs`)", () => {
    expect(buildSandboxLogsArgv(["cli"], "sess")).toEqual(["cli", "logs", "sess", "-n", "50"]);
  });

  it("honors a custom line count", () => {
    expect(buildSandboxLogsArgv(["cli"], "sess", { lines: 10 })).toEqual([
      "cli",
      "logs",
      "sess",
      "-n",
      "10",
    ]);
  });

  it("supports a multi-element cli prefix", () => {
    expect(buildSandboxLogsArgv(["mise", "exec", "--", "openshell"], "sess")).toEqual([
      "mise",
      "exec",
      "--",
      "openshell",
      "logs",
      "sess",
      "-n",
      "50",
    ]);
  });
});

describe("formatSandboxExitedError (GH #75 piece 4 — surface real supervisor failure)", () => {
  it("includes the fetched supervisor logs verbatim when present", () => {
    const msg = formatSandboxExitedError("my-sess", "ERROR Policy fetch failed: transport error");
    expect(msg).toContain('sandbox "my-sess" exited during provisioning');
    expect(msg).toContain("ERROR Policy fetch failed: transport error");
  });

  it("falls back to a network-reachability hint when no logs were received", () => {
    const msg = formatSandboxExitedError("my-sess", "");
    expect(msg).toContain("no supervisor");
    expect(msg).toContain("openlock doctor");
    expect(msg).toContain("podman logs openshell-sandbox-my-sess");
  });
});

// openlock-weo: on Linux the gateway's phase is derived from observed driver
// state gated on a container healthcheck, so it can still read Stopped for
// up to ~35s (observed; consistent with either the healthcheck cadence or
// the gateway's reconcile sweep — not disambiguated) after an explicit
// `openshell sandbox start` already returned success and the container is
// Up. assertSandboxNotExited/waitForSandboxReady must tolerate that lag only
// right after such a Start, and still fast-fail on Stopped everywhere else
// (a container nobody just started is genuinely dead, not lagging).
//
// No mocking convention exists in this file (everything above is pure
// argv/string functions) and getCliInvocation/Bun.spawn aren't module-mocked
// anywhere in the repo, so these drive the real functions against a
// throwaway fake `openshell` CLI script, wired in via the dev/test-only
// OPENLOCK_OPENSHELL_BIN override (src/sandbox/fork-binaries.ts). The
// scenario (phase, exec exit code) is baked directly into the script content
// per test rather than threaded through env vars: Bun.spawn snapshots
// process.env at first use rather than re-reading live mutations, so a
// `FAKE_PHASE`-style env var set in the test body is invisible to the child.
// openlock-vtl: `getFailure` simulates `openshell sandbox get` itself
// exiting non-zero (a transport-level failure, e.g. gateway down) rather
// than succeeding with a phase — orthogonal to `phase`, which only applies
// on the success path. Defaults to unset so every pre-existing call site
// (which only ever exercises the success path) is unaffected.
function writeFakeOpenshellCli(
  phase: string,
  execExitCode = 1,
  getFailure?: { exitCode: number; stderr: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-openshell-"));
  const bin = join(dir, "openshell");
  const getBranch =
    getFailure !== undefined
      ? [`  echo '${getFailure.stderr}' 1>&2`, `  exit ${getFailure.exitCode}`]
      : [`  echo '{"phase":"${phase}"}'`, "  exit 0"];
  writeFileSync(
    bin,
    [
      "#!/bin/bash",
      'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
      ...getBranch,
      'elif [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
      `  exit ${execExitCode}`,
      'elif [ "$1" = "logs" ]; then',
      '  echo "fake supervisor log"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("getSandboxState (openlock-vtl)", () => {
  const savedBin = process.env.OPENLOCK_OPENSHELL_BIN;

  afterEach(() => {
    if (savedBin === undefined) delete process.env.OPENLOCK_OPENSHELL_BIN;
    else process.env.OPENLOCK_OPENSHELL_BIN = savedBin;
  });

  it("maps a genuine not-found (NotFound in stderr) to 'missing'", async () => {
    process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Ready", 1, {
      exitCode: 1,
      stderr: "Error: sandbox not found",
    });
    await expect(getSandboxState("sess")).resolves.toBe("missing");
  });

  it("maps a genuine not-found (NotFound spelled as the proto variant) to 'missing'", async () => {
    process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Ready", 1, {
      exitCode: 1,
      stderr: "status: NotFound, message: no such sandbox",
    });
    await expect(getSandboxState("sess")).resolves.toBe("missing");
  });

  // The actual bug: a non-zero exit that is NOT a genuine not-found (a
  // transport-level failure — gateway down, connection refused) must NOT
  // collapse into "missing". Before the fix, getSandboxState mapped ANY
  // non-zero exit to "missing" unconditionally, making a down gateway
  // indistinguishable from a genuinely-absent sandbox.
  it("maps a transport-level failure (connection refused, non-NotFound stderr) to 'unreachable', NOT 'missing'", async () => {
    process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Ready", 1, {
      exitCode: 1,
      stderr: "Error: transport error: Connection refused (os error 61)",
    });
    const state = await getSandboxState("sess");
    expect(state).toBe("unreachable");
    expect(state).not.toBe("missing");
  });

  it("still maps a successful call through parseSandboxGetPhase (unaffected by the stderr path)", async () => {
    process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Ready");
    await expect(getSandboxState("sess")).resolves.toBe("running");
  });
});

describe("assertSandboxNotExited / waitForSandboxReady (openlock-weo)", () => {
  const savedBin = process.env.OPENLOCK_OPENSHELL_BIN;

  afterEach(() => {
    if (savedBin === undefined) delete process.env.OPENLOCK_OPENSHELL_BIN;
    else process.env.OPENLOCK_OPENSHELL_BIN = savedBin;
  });

  describe("assertSandboxNotExited", () => {
    it("no-ops on phase Stopped when tolerateStopped is set (post-explicit-Start)", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Stopped");
      await expect(
        assertSandboxNotExited("sess", { tolerateStopped: true }),
      ).resolves.toBeUndefined();
    });

    it("still throws on phase Stopped when not tolerated (cold path, nothing started)", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Stopped");
      await expect(assertSandboxNotExited("sess")).rejects.toThrow(/exited during provisioning/);
    });

    it("throws on Error even with tolerateStopped set — only Stopped is transient", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Error");
      await expect(assertSandboxNotExited("sess", { tolerateStopped: true })).rejects.toThrow(
        /exited during provisioning/,
      );
    });

    // openlock-ddd: Deleting is terminal (never reaches Ready) but the
    // message must be specific — NOT the generic "exited during
    // provisioning" formatSandboxExitedError produces for real failures.
    it("fails fast with an accurate 'being deleted' message on phase Deleting", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Deleting");
      await expect(assertSandboxNotExited("sess")).rejects.toThrow(/sess is being deleted/);
      await expect(assertSandboxNotExited("sess")).rejects.not.toThrow(
        /exited during provisioning/,
      );
    });

    // openlock-vtl: "unreachable" is NOT a confirmed death — a transient
    // transport hiccup mid-poll must not abort a wait that would otherwise
    // succeed once the gateway answers again.
    it("no-ops on 'unreachable' (transport failure), same as a merely-slow sandbox", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Ready", 1, {
        exitCode: 1,
        stderr: "Error: transport error: Connection refused (os error 61)",
      });
      await expect(assertSandboxNotExited("sess")).resolves.toBeUndefined();
    });
  });

  describe("waitForSandboxReady", () => {
    it("keeps polling through a post-Start Stopped phase mid-budget (does not fail on the first sighting)", async () => {
      // Loose upper bound (well above one 500ms poll tick, well below the
      // full budget) proves it tolerated at least one Stopped reading
      // instead of throwing on the very first poll.
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Stopped");
      const start = Date.now();
      await expect(
        waitForSandboxReady("sess", { tolerateStopped: true, timeoutMs: 1500 }),
      ).rejects.toThrow(/exited during provisioning/);
      expect(Date.now() - start).toBeGreaterThanOrEqual(500);
    });

    // openlock-hsn: if a resume-triggered Start reports success but the
    // container never actually restarts, phase stays Stopped forever. The
    // tolerant poll loop above must not swallow that into a bare timeout —
    // the final strict check must still surface the real cause (with logs).
    it("surfaces the exited error (with supervisor logs), not a bare timeout, when Stopped never resolves under tolerateStopped", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Stopped");
      await expect(
        waitForSandboxReady("sess", { tolerateStopped: true, timeoutMs: 700 }),
      ).rejects.toThrow(/exited during provisioning.*fake supervisor log/s);
    });

    it("fast-fails on Stopped when not tolerated, well before the timeout budget", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Stopped");
      const start = Date.now();
      await expect(waitForSandboxReady("sess", { timeoutMs: 5000 })).rejects.toThrow(
        /exited during provisioning/,
      );
      expect(Date.now() - start).toBeLessThan(2000);
    });

    // openlock-ddd: this is the actual bug — a sandbox racing a delete
    // against this attach/create previously polled for the FULL timeout
    // budget (60s default, 90s on resume) before reporting a generic "did
    // not reach Ready state", instead of failing fast with the real,
    // knowable cause.
    it("fast-fails on Deleting with an accurate message, well before the timeout budget", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Deleting");
      const start = Date.now();
      await expect(waitForSandboxReady("sess", { timeoutMs: 5000 })).rejects.toThrow(
        /sess is being deleted/,
      );
      expect(Date.now() - start).toBeLessThan(2000);
    });

    // The final strict check must only ever escalate to a more specific
    // error, never mask a genuine "still provisioning, just slow" timeout —
    // a sandbox stuck in a live-but-not-Ready phase (never Stopped/Error/
    // missing/Deleting) must still fall through to the generic timeout.
    // Provisioning and Unknown are both real phases that collapse to
    // ContainerState "other" and must both keep polling rather than fail
    // fast (openlock-ddd: Unknown deliberately gets no special treatment).
    it("still reports the generic timeout for a sandbox that is merely slow (Provisioning, never Stopped/dead)", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Provisioning");
      await expect(waitForSandboxReady("sess", { timeoutMs: 700 })).rejects.toThrow(
        /did not reach Ready state within 700ms/,
      );
    });

    it("still reports the generic timeout for phase Unknown (driver couldn't determine state, not proof of death)", async () => {
      process.env.OPENLOCK_OPENSHELL_BIN = writeFakeOpenshellCli("Unknown");
      await expect(waitForSandboxReady("sess", { timeoutMs: 700 })).rejects.toThrow(
        /did not reach Ready state within 700ms/,
      );
    });
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

  it("injects no provider env placeholder for anthropic+claude_code (OAuth-file flow)", () => {
    // anthropic is now claude_code-only and uses a staged .credentials.json,
    // not an env placeholder. The previous opencode+anthropic x-api-key path no
    // longer exists.
    const env = buildSandboxEnv({
      providerId: "anthropic",
      harness: "claude_code",
      repoConfigEnv: {},
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("repo-config env wins over placeholder when user explicitly sets the same key", () => {
    const env = buildSandboxEnv({
      providerId: "openrouter",
      harness: "opencode",
      repoConfigEnv: { OPENROUTER_API_KEY: "user-explicitly-set" },
    });
    expect(env.OPENROUTER_API_KEY).toBe("user-explicitly-set");
  });

  it("sets CLAUDE_CONFIG_DIR for claude_code harness", () => {
    const env = buildSandboxEnv({
      providerId: "anthropic",
      harness: "claude_code",
      repoConfigEnv: {},
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/sandbox/.openlock/claude-config");
  });

  it("does NOT set CLAUDE_CONFIG_DIR for opencode harness", () => {
    const env = buildSandboxEnv({
      providerId: "anthropic",
      harness: "opencode",
      repoConfigEnv: {},
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
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

  it("appends --log-level debug when debugEgress is set", () => {
    const argv = buildOpenshellCreateArgv({ ...base, debugEgress: true });
    const idx = argv.indexOf("--log-level");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("debug");
  });

  it("omits --log-level by default", () => {
    const argv = buildOpenshellCreateArgv(base);
    expect(argv).not.toContain("--log-level");
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

  test("buildOpenshellCreateArgv appends one --provider per attached bundle after the primary", () => {
    const argv = buildOpenshellCreateArgv({
      sessionName: "s",
      imageTag: "img",
      uploadDir: "/tmp/u",
      policy: "/p.yaml",
      providerId: "anthropic",
      command: ["/bin/true"],
      attachProviders: ["github", "internal"],
    });
    const providerFlags: string[] = [];
    for (const [i, tok] of argv.entries()) {
      if (tok === "--provider") providerFlags.push(argv[i + 1]!);
    }
    expect(providerFlags).toEqual(["anthropic", "github", "internal"]);
  });

  test("buildOpenshellCreateArgv with no attachProviders emits only the primary", () => {
    const argv = buildOpenshellCreateArgv({
      sessionName: "s",
      imageTag: "img",
      uploadDir: "/tmp/u",
      policy: "/p.yaml",
      providerId: "anthropic",
      command: ["/bin/true"],
    });
    const count = argv.filter((t) => t === "--provider").length;
    expect(count).toBe(1);
  });

  // openlock-251: openlock set no resource limits anywhere, so every sandbox
  // silently inherited openshell's own cpu_limit=2 regardless of the host's
  // actual resources. --cpu/--memory must reach the argv when set...
  it("emits --cpu when set", () => {
    const argv = buildOpenshellCreateArgv({ ...base, cpu: "2" });
    const idx = argv.indexOf("--cpu");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("2");
  });

  it("emits --memory when set", () => {
    const argv = buildOpenshellCreateArgv({ ...base, memory: "4Gi" });
    const idx = argv.indexOf("--memory");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("4Gi");
  });

  // ...and this is the regression guard proving the fix doesn't silently
  // start pinning limits for everyone: unset must produce byte-identical
  // argv to today, so every existing sandbox keeps inheriting openshell's
  // default exactly as before.
  it("omits --cpu and --memory entirely when unset (regression guard)", () => {
    const argv = buildOpenshellCreateArgv(base);
    expect(argv).not.toContain("--cpu");
    expect(argv).not.toContain("--memory");
    // Full-argv fixture (not just "not.toContain") so an unset cpu/memory
    // provably produces the exact same argv as before this feature existed —
    // proving openlock did not silently start pinning limits for everyone.
    expect(argv).toEqual([
      "sandbox",
      "create",
      "--name",
      "s",
      "--from",
      "img",
      "--upload",
      "/tmp/staging:/sandbox/",
      "--no-git-ignore",
      "--policy",
      "/tmp/policy.yaml",
      "--provider",
      "anthropic",
      "--no-tty",
      "--",
      "/bin/bash",
    ]);
  });
});
