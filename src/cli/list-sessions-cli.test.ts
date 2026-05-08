import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
let originalHome: string | undefined;

function makeSession(name: string) {
  const dir = join(tmpHome, ".local", "state", "openlock", "sessions", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id: name,
      name,
      repoPath: `/tmp/${name}`,
      caps: [],
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
      env: { ...process.env, HOME: tmpHome },
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
      env: { ...process.env, HOME: tmpHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("");
    expect(proc.exitCode).toBe(0);
  });
});
