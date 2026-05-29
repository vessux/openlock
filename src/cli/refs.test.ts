import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureRepoIsGit } from "../sandbox/ensure-repo";
import type { SessionMeta } from "../sandbox/session-store";
import { type RefsDeps, refsCmd } from "./refs";

const testDir = join(import.meta.dir, "../../.test-refs");

async function run(cmd: string[], cwd: string): Promise<void> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore", env });
  await proc.exited;
}

// Read the actual default-branch name from the repo. Avoids hard-coding
// `master` vs `main` — newer git defaults to `main`, older to `master`.
async function defaultBranch(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "symbolic-ref", "--short", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

function fakeMeta(name: string, repoPath: string): SessionMeta {
  return {
    id: name,
    name,
    repoPath,
    image: "x",
    policy: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    attachedPid: null,
    harness: "claude_code",
  };
}

describe("refs list", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("prints empty message when no sessions", async () => {
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["list"], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("No sandbox commits"))).toBe(true);
  });

  it("prints empty when sessions exist but have no AHEAD>0 refs", async () => {
    const repoPath = join(testDir, "empty-repo");
    mkdirSync(repoPath);
    await ensureRepoIsGit(repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "init"], repoPath);
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sess-empty", repoPath)],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["list"], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("No sandbox commits"))).toBe(true);
  });

  it("lists rows for sessions with sandbox commits ahead of host", async () => {
    const repoPath = join(testDir, "row-repo");
    mkdirSync(repoPath);
    await ensureRepoIsGit(repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "host-1"], repoPath);
    const branch = await defaultBranch(repoPath);
    // Two commits ahead in sandbox namespace.
    await run(["git", "checkout", "-b", "tmp"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "sb-1"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "sb-2"], repoPath);
    await run(["git", "update-ref", `refs/sandbox/sess-row/${branch}`, "tmp"], repoPath);
    // Switch back via OID rather than branch name to be portable across master/main defaults.
    // Capture the post-checkout HEAD before deleting tmp.
    const headBefore = Bun.spawn(["git", "rev-parse", "tmp~2"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const baseOid = (await new Response(headBefore.stdout).text()).trim();
    await headBefore.exited;
    await run(["git", "checkout", baseOid], repoPath);
    await run(["git", "branch", "-D", "tmp"], repoPath);

    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sess-row", repoPath)],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["list"], deps);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("sess-row");
    expect(out).toContain(branch);
    expect(out).toMatch(/\b2\b/); // ahead = 2
    // Not promoted yet.
    expect(out).toContain("—");
  });

  it("marks promoted when openlock/<session> matches the sandbox OID", async () => {
    const repoPath = join(testDir, "promo-repo");
    mkdirSync(repoPath);
    await ensureRepoIsGit(repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "host-1"], repoPath);
    const branch = await defaultBranch(repoPath);
    await run(["git", "checkout", "-b", "tmp"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "sb-1"], repoPath);
    await run(["git", "update-ref", `refs/sandbox/sess-pm/${branch}`, "tmp"], repoPath);
    await run(["git", "update-ref", "refs/heads/openlock/sess-pm", "tmp"], repoPath);
    const headBefore = Bun.spawn(["git", "rev-parse", "tmp~"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const baseOid = (await new Response(headBefore.stdout).text()).trim();
    await headBefore.exited;
    await run(["git", "checkout", baseOid], repoPath);
    await run(["git", "branch", "-D", "tmp"], repoPath);

    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sess-pm", repoPath)],
      log: (s) => lines.push(s),
    };
    await refsCmd(["list"], deps);
    const out = lines.join("\n");
    expect(out).toContain("openlock/sess-pm");
  });

  it("--json emits machine-readable rows", async () => {
    const repoPath = join(testDir, "json-repo");
    mkdirSync(repoPath);
    await ensureRepoIsGit(repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "host-1"], repoPath);
    const branch = await defaultBranch(repoPath);
    await run(["git", "checkout", "-b", "tmp"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "sb-1"], repoPath);
    await run(["git", "update-ref", `refs/sandbox/sess-json/${branch}`, "tmp"], repoPath);
    const headBefore = Bun.spawn(["git", "rev-parse", "tmp~"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const baseOid = (await new Response(headBefore.stdout).text()).trim();
    await headBefore.exited;
    await run(["git", "checkout", baseOid], repoPath);
    await run(["git", "branch", "-D", "tmp"], repoPath);

    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sess-json", repoPath)],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["list", "--json"], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      session: "sess-json",
      branch,
      ahead: 1,
      promoted: null,
    });
    expect(parsed[0].commit).toMatch(/^[0-9a-f]+$/);
  });

  it("filters to a specific session when arg given", async () => {
    const repoPath = join(testDir, "filter-repo");
    mkdirSync(repoPath);
    await ensureRepoIsGit(repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "host-1"], repoPath);
    const branch = await defaultBranch(repoPath);
    await run(["git", "checkout", "-b", "tmp"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "sb-1"], repoPath);
    await run(["git", "update-ref", `refs/sandbox/sess-A/${branch}`, "tmp"], repoPath);
    await run(["git", "update-ref", `refs/sandbox/sess-B/${branch}`, "tmp"], repoPath);
    const headBefore = Bun.spawn(["git", "rev-parse", "tmp~"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const baseOid = (await new Response(headBefore.stdout).text()).trim();
    await headBefore.exited;
    await run(["git", "checkout", baseOid], repoPath);
    await run(["git", "branch", "-D", "tmp"], repoPath);

    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sess-A", repoPath), fakeMeta("sess-B", repoPath)],
      log: (s) => lines.push(s),
    };
    await refsCmd(["list", "sess-A"], deps);
    const out = lines.join("\n");
    expect(out).toContain("sess-A");
    expect(out).not.toContain("sess-B");
  });

  it("errors when filtered session does not exist", async () => {
    const errs: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [],
      log: () => {},
      err: (s) => errs.push(s),
    };
    const code = await refsCmd(["list", "missing"], deps);
    expect(code).toBe(1);
    expect(errs.some((l) => l.includes("missing"))).toBe(true);
  });
});

describe("refs promote", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  async function setup(
    repoName: string,
    sessionName: string,
  ): Promise<{ repoPath: string; oid: string; defaultBranchName: string }> {
    const repoPath = join(testDir, repoName);
    mkdirSync(repoPath);
    await ensureRepoIsGit(repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "host"], repoPath);
    // capture default branch name from this repo
    const dbProc = Bun.spawn(["git", "symbolic-ref", "--short", "HEAD"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const defaultBranchName = (await new Response(dbProc.stdout).text()).trim();
    await dbProc.exited;
    await run(["git", "checkout", "-b", "tmp"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "sb"], repoPath);
    const p = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const oid = (await new Response(p.stdout).text()).trim();
    await p.exited;
    await run(
      ["git", "update-ref", `refs/sandbox/${sessionName}/${defaultBranchName}`, oid],
      repoPath,
    );
    // checkout original commit by OID for portability
    const baseProc = Bun.spawn(["git", "rev-parse", "tmp~"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const baseOid = (await new Response(baseProc.stdout).text()).trim();
    await baseProc.exited;
    await run(["git", "checkout", baseOid], repoPath);
    await run(["git", "branch", "-D", "tmp"], repoPath);
    return { repoPath, oid, defaultBranchName };
  }

  it("direct args: promotes the named branch", async () => {
    const { repoPath, oid, defaultBranchName } = await setup("d1-repo", "sessD1");
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessD1", repoPath)],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["promote", "sessD1", defaultBranchName], deps);
    expect(code).toBe(0);

    const p = Bun.spawn(["git", "rev-parse", "refs/heads/openlock/sessD1"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const writtenOid = (await new Response(p.stdout).text()).trim();
    await p.exited;
    expect(writtenOid).toBe(oid);
    expect(lines.some((l) => l.includes("Promoted to openlock/sessD1"))).toBe(true);
  });

  it("session-only: auto-picks when exactly one branch", async () => {
    const { repoPath } = await setup("a1-repo", "sessA1");
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessA1", repoPath)],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["promote", "sessA1"], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("Promoted to openlock/sessA1"))).toBe(true);
  });

  it("session-only: invokes picker when multiple branches", async () => {
    const { repoPath } = await setup("m1-repo", "sessM1");
    // Add a second sandbox branch by aliasing the existing sandbox ref to a new sub-name.
    // We need both refs to have AHEAD>0; reuse the existing OID.
    const refsList = Bun.spawn(
      ["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/sandbox/sessM1/"],
      { cwd: repoPath, stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(refsList.stdout).text();
    await refsList.exited;
    const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
    const [_existingRef, existingOid] = firstLine.split(/\s+/);
    await run(["git", "update-ref", "refs/sandbox/sessM1/feature-x", existingOid ?? ""], repoPath);

    const lines: string[] = [];
    const pickedRows: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessM1", repoPath)],
      log: (s) => lines.push(s),
      pick: async (items, render) => {
        for (const it of items) pickedRows.push(render(it));
        return items[0] ?? null;
      },
    };
    const code = await refsCmd(["promote", "sessM1"], deps);
    expect(code).toBe(0);
    expect(pickedRows.length).toBe(2);
  });

  it("no args: picker over all sessions", async () => {
    const { repoPath: r1 } = await setup("n1-repo", "sessN1");
    const { repoPath: r2 } = await setup("n2-repo", "sessN2");

    const lines: string[] = [];
    const renderedItems: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessN1", r1), fakeMeta("sessN2", r2)],
      log: (s) => lines.push(s),
      pick: async (items, render) => {
        for (const it of items) renderedItems.push(render(it));
        return items[0] ?? null;
      },
    };
    const code = await refsCmd(["promote"], deps);
    expect(code).toBe(0);
    expect(renderedItems.length).toBe(2);
  });

  it("--force overwrites diverged target", async () => {
    const { repoPath, oid, defaultBranchName } = await setup("f1-repo", "sessF1");
    // Pre-create target at unrelated OID by checking out and adding commit.
    await run(["git", "checkout", "-b", "openlock/sessF1"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "diverged"], repoPath);
    // checkout HEAD~ on default branch by OID
    const baseProc = Bun.spawn(["git", "rev-parse", "openlock/sessF1~"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const baseOid = (await new Response(baseProc.stdout).text()).trim();
    await baseProc.exited;
    await run(["git", "checkout", baseOid], repoPath);

    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessF1", repoPath)],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["promote", "sessF1", defaultBranchName, "--force"], deps);
    expect(code).toBe(0);

    const p = Bun.spawn(["git", "rev-parse", "refs/heads/openlock/sessF1"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const writtenOid = (await new Response(p.stdout).text()).trim();
    await p.exited;
    expect(writtenOid).toBe(oid);
  });

  it("errors when --force missing on diverged target", async () => {
    const { repoPath, defaultBranchName } = await setup("d2-repo", "sessD2");
    await run(["git", "checkout", "-b", "openlock/sessD2"], repoPath);
    await run(["git", "commit", "--allow-empty", "-m", "diverged"], repoPath);
    const baseProc = Bun.spawn(["git", "rev-parse", "openlock/sessD2~"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const baseOid = (await new Response(baseProc.stdout).text()).trim();
    await baseProc.exited;
    await run(["git", "checkout", baseOid], repoPath);

    const errs: string[] = [];
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessD2", repoPath)],
      log: (s) => lines.push(s),
      err: (s) => errs.push(s),
    };
    const code = await refsCmd(["promote", "sessD2", defaultBranchName], deps);
    expect(code).toBe(1);
    const all = [...lines, ...errs].join("\n");
    expect(all).toContain("diverged");
    expect(all).toContain("--force");
  });

  it("-b <name> uses custom target name", async () => {
    const { repoPath, oid, defaultBranchName } = await setup("b1-repo", "sessB1");
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessB1", repoPath)],
      log: (s) => lines.push(s),
    };
    const code = await refsCmd(["promote", "sessB1", defaultBranchName, "-b", "review/B1"], deps);
    expect(code).toBe(0);

    const p = Bun.spawn(["git", "rev-parse", "refs/heads/review/B1"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const writtenOid = (await new Response(p.stdout).text()).trim();
    await p.exited;
    expect(writtenOid).toBe(oid);
  });

  it("errors when no rows exist anywhere", async () => {
    const errs: string[] = [];
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [],
      log: (s) => lines.push(s),
      err: (s) => errs.push(s),
    };
    const code = await refsCmd(["promote"], deps);
    expect(code).toBe(1);
    expect([...lines, ...errs].join("\n")).toContain("No sandbox commits");
  });

  it("errors when session has no rows", async () => {
    const repoPath = join(testDir, "z1-repo");
    mkdirSync(repoPath);
    await ensureRepoIsGit(repoPath);
    const errs: string[] = [];
    const lines: string[] = [];
    const deps: RefsDeps = {
      listSessions: () => [fakeMeta("sessZ1", repoPath)],
      log: (s) => lines.push(s),
      err: (s) => errs.push(s),
    };
    const code = await refsCmd(["promote", "sessZ1"], deps);
    expect(code).toBe(1);
    expect([...lines, ...errs].join("\n")).toContain("no commits");
  });
});
