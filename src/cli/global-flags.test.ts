import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

// openlock-j9d: src/cli.ts's pre-dispatch global-flag scan used `args.includes(...)`
// over the ENTIRE argv, with no awareness of the `--` separator that `exec`/`shell`
// use to mark "everything after this belongs to the exec'd command". So
// `openlock exec X -- foo -v` (or `--version`, or `--print-base-tag`) silently
// answered with openlock's OWN version/base-tag and exit 0, without ever running
// `foo` — a silent no-op with a success exit code, the worst possible shape for a
// scripted/CI caller. Fixed by scanning only the prefix before the first `--`.

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "olcli-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// `exec` resolves its session-name positional purely against the local
// session store (loadSessionByName -> filesystem under $HOME), with no
// gateway/network call — so pointing HOME at an empty temp dir makes
// "no such session: X" the fast, deterministic, hermetic outcome for any
// session name, letting these tests assert dispatch actually happened
// without depending on gateway state.
function runCli(args: string[]) {
  return Bun.spawn({
    cmd: ["bun", "src/cli.ts", ...args],
    env: { ...process.env, HOME: tmpHome },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("global flag scan respects the `--` separator (openlock-j9d)", () => {
  it("does not intercept -v after -- meant for the exec'd command", async () => {
    const proc = runCli(["exec", "no-such-session", "--", "foo", "-v"]);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    // The bug: stdout === pkg.version and exitCode === 0 here, because the
    // top-level scan found "-v" anywhere in argv and short-circuited before
    // `exec` ever ran. Dispatch actually happening looks like exec's own
    // "no such session" error on stderr with a non-zero exit.
    expect(stdout.trim()).not.toBe(pkg.version);
    expect(stderr).toContain("no such session: no-such-session");
    expect(exitCode).toBe(1);
  });

  it("does not intercept --version after -- meant for the exec'd command", async () => {
    const proc = runCli(["exec", "no-such-session", "--", "foo", "--version"]);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    expect(stdout.trim()).not.toBe(pkg.version);
    expect(stderr).toContain("no such session: no-such-session");
    expect(exitCode).toBe(1);
  });

  it("does not intercept --print-base-tag after -- meant for the exec'd command", async () => {
    const proc = runCli(["exec", "no-such-session", "--", "foo", "--print-base-tag"]);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    expect(stdout.trim()).not.toMatch(/^ghcr\.io\//);
    expect(stderr).toContain("no such session: no-such-session");
    expect(exitCode).toBe(1);
  });

  it("does not intercept --help/-h after -- meant for the exec'd command (already correct; regression guard)", async () => {
    const proc = runCli(["exec", "no-such-session", "--", "foo", "--help"]);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    expect(stdout).not.toContain("openlock - sandbox orchestration toolkit");
    expect(stderr).toContain("no such session: no-such-session");
    expect(exitCode).toBe(1);
  });

  it("positive control: plain `openlock --version` still prints the version and exits 0", async () => {
    const proc = runCli(["--version"]);
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("positive control: plain `openlock -v` still prints the version and exits 0", async () => {
    const proc = runCli(["-v"]);
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("positive control: `openlock version` still prints the version and exits 0", async () => {
    const proc = runCli(["version"]);
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("positive control: plain `openlock --print-base-tag` still works and exits 0", async () => {
    const proc = runCli(["--print-base-tag"]);
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^ghcr\.io\/vessux\/openlock-base:[0-9a-f]{12}$/);
  });

  it("positive control: plain `openlock --help` still prints usage and exits 0", async () => {
    const proc = runCli(["--help"]);
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("openlock - sandbox orchestration toolkit");
  });
});
