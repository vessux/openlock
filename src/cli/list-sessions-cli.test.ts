import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
let originalHome: string | undefined;

// The state dir this suite's spawns resolve to. Overriding HOME already
// isolates resolveStateDir() under its current precedence (explicit >
// OPENLOCK_STATE_DIR > HOME-relative default) as long as OPENLOCK_STATE_DIR
// isn't set in the ambient environment — but that's an incidental
// consequence of HOME being overridden for session-store isolation, not a
// deliberate one. Passing OPENLOCK_STATE_DIR explicitly (openlock-u7ca) makes
// the isolation intent stand on its own, independent of that precedence
// detail and immune to a stray OPENLOCK_STATE_DIR in whoever's shell runs
// this suite.
function stateDirFor(home: string): string {
  return join(home, ".local", "state", "openlock");
}

function makeSession(name: string) {
  const dir = join(stateDirFor(tmpHome), "sessions", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id: name,
      name,
      repoPath: `/tmp/${name}`,
      image: "img",
      policy: "default",
      createdAt: "2026-05-09T00:00:00Z",
      lastAttachedAt: null,
      attachedPid: null,
    }),
  );
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ollist-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("openlock __list-sessions", () => {
  it("prints session names one per line", async () => {
    makeSession("alpha");
    makeSession("beta");
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli.ts", "__list-sessions"],
      env: { ...process.env, HOME: tmpHome, OPENLOCK_STATE_DIR: stateDirFor(tmpHome) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const names = out.trim().split("\n").sort();
    expect(names).toEqual(["alpha", "beta"]);
    expect(proc.exitCode).toBe(0);
  });

  it("prints nothing and exits 0 when no sessions exist", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli.ts", "__list-sessions"],
      env: { ...process.env, HOME: tmpHome, OPENLOCK_STATE_DIR: stateDirFor(tmpHome) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("");
    expect(proc.exitCode).toBe(0);
  });
});
