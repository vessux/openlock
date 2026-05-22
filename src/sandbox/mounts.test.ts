import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  readFileSync as fsReadFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindMountArgs,
  gitBundleMounts,
  type Mount,
  parseMounts,
  stageMounts,
  stagingPathFor,
  workdirMount,
} from "./mounts";

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "openlock-mounts-test-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("parseMounts", () => {
  it("returns [] when raw is undefined", () => {
    expect(parseMounts(undefined, projectRoot)).toEqual([]);
  });

  it("returns [] when raw is an empty list", () => {
    expect(parseMounts([], projectRoot)).toEqual([]);
  });

  it("throws when raw is not a list", () => {
    expect(() => parseMounts({}, projectRoot)).toThrow(/'mounts' must be a list/);
  });

  it("resolves a relative source path against projectRoot", () => {
    const src = join(projectRoot, "seeds");
    mkdirSync(src);
    const [m] = parseMounts(
      [{ source: "seeds", target: "/sandbox/.openlock/x", type: "copy-once" }],
      projectRoot,
    );
    expect(m?.source).toBe(src);
  });

  it("expands ~ in source", () => {
    const testDir = join(homedir(), ".openlock-mounts-test-tmp");
    mkdirSync(testDir, { recursive: true });
    try {
      const [m] = parseMounts(
        [
          {
            source: "~/.openlock-mounts-test-tmp",
            target: "/sandbox/.openlock/x",
            type: "copy-once",
          },
        ],
        projectRoot,
      );
      expect(m?.source).toBe(testDir);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("accepts absolute source", () => {
    const src = join(projectRoot, "abs");
    mkdirSync(src);
    const [m] = parseMounts(
      [{ source: src, target: "/sandbox/.openlock/x", type: "copy-once" }],
      projectRoot,
    );
    expect(m?.source).toBe(src);
  });

  it("throws when source is missing or not a string", () => {
    expect(() =>
      parseMounts([{ target: "/sandbox/.openlock/x", type: "copy-once" }], projectRoot),
    ).toThrow(/source/);
  });

  it("throws when source does not exist", () => {
    expect(() =>
      parseMounts(
        [{ source: "/nope/does/not/exist", target: "/sandbox/.openlock/x", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/source.*does not exist/);
  });

  it("throws when source is a file, not a directory", () => {
    const f = join(projectRoot, "file");
    writeFileSync(f, "x");
    expect(() =>
      parseMounts([{ source: f, target: "/sandbox/.openlock/x", type: "copy-once" }], projectRoot),
    ).toThrow(/source.*not a directory/);
  });

  it("throws when target is missing", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() => parseMounts([{ source: src, type: "copy-once" }], projectRoot)).toThrow(/target/);
  });

  it("throws when target is not absolute", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "sandbox/x", type: "copy-once" }], projectRoot),
    ).toThrow(/absolute/);
  });

  it("throws when target is not under /sandbox/.openlock/", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/etc/passwd", type: "copy-once" }], projectRoot),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("throws when target is under /sandbox/ but not under /sandbox/.openlock/", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/sandbox/scratch", type: "copy-once" }], projectRoot),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("throws when target equals /sandbox/.openlock or /sandbox/.openlock/", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/sandbox/.openlock", type: "copy-once" }], projectRoot),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("throws when target contains a .. segment", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/../etc/passwd", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/must not contain '\.\.'/);
  });

  it("rejects /sandbox/.openlock/../etc/passwd (prefix-bypass via ..)", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/../etc/passwd", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/must not contain '\.\.'/);
  });

  it("throws when target's top segment collides with openlock-internal name (repo.bundle)", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/repo.bundle", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name 'repo\.bundle'/);
  });

  it("throws when target's top segment collides with openlock-internal name (.gitconfig)", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/.gitconfig", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name '\.gitconfig'/);
  });

  it("also catches collision when reserved name is the prefix of a deeper path", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/repo.bundle/sub", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name 'repo\.bundle'/);
  });

  it("throws when target's top segment is reserved 'bundles' (copy-once)", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/bundles", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name 'bundles'/);
  });

  it("throws when target nests under reserved 'bundles' (copy-once)", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/bundles/sub", type: "copy-once" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name 'bundles'/);
  });

  it("throws when two mounts share a target", () => {
    const a = join(projectRoot, "a");
    const b = join(projectRoot, "b");
    mkdirSync(a);
    mkdirSync(b);
    expect(() =>
      parseMounts(
        [
          { source: a, target: "/sandbox/.openlock/x", type: "copy-once" },
          { source: b, target: "/sandbox/.openlock/x", type: "copy-refresh" },
        ],
        projectRoot,
      ),
    ).toThrow(/duplicate target/);
  });

  it("throws when type is missing", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/sandbox/.openlock/x" }], projectRoot),
    ).toThrow(/type/);
  });

  it("throws when type is unknown", () => {
    const src = join(projectRoot, "s");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/x", type: "no-such-type" }],
        projectRoot,
      ),
    ).toThrow(/unknown type/);
  });

  it("accepts type copy-once and copy-refresh", () => {
    const a = join(projectRoot, "a");
    const b = join(projectRoot, "b");
    mkdirSync(a);
    mkdirSync(b);
    const ms = parseMounts(
      [
        { source: a, target: "/sandbox/.openlock/a", type: "copy-once" },
        { source: b, target: "/sandbox/.openlock/b", type: "copy-refresh" },
      ],
      projectRoot,
    );
    expect(ms.map((m) => m.type)).toEqual(["copy-once", "copy-refresh"]);
  });

  it("accepts type: bind with a directory source", () => {
    const src = join(projectRoot, "bind-dir");
    mkdirSync(src);
    const [m] = parseMounts(
      [{ source: src, target: "/sandbox/.openlock/bound", type: "bind" }],
      projectRoot,
    );
    expect(m?.type).toBe("bind");
    expect(m?.source).toBe(src);
  });

  it("accepts type: bind with a file source", () => {
    const f = join(projectRoot, "bind-file");
    writeFileSync(f, "hello");
    const [m] = parseMounts(
      [{ source: f, target: "/sandbox/.openlock/file", type: "bind" }],
      projectRoot,
    );
    expect(m?.type).toBe("bind");
    expect(m?.source).toBe(f);
  });

  it("accepts type: git-bundle with a git working tree source", () => {
    const src = join(projectRoot, "repo");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    const [m] = parseMounts(
      [{ source: src, target: "/sandbox/repo", type: "git-bundle" }],
      projectRoot,
    );
    expect(m?.type).toBe("git-bundle");
    expect(m?.source).toBe(src);
  });

  it("rejects type: git-bundle with non-git directory source", () => {
    const src = join(projectRoot, "not-a-repo");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/sandbox/repo", type: "git-bundle" }], projectRoot),
    ).toThrow(/not a git working tree/);
  });

  it("rejects type: git-bundle with file source", () => {
    const f = join(projectRoot, "file");
    writeFileSync(f, "");
    expect(() =>
      parseMounts([{ source: f, target: "/sandbox/repo", type: "git-bundle" }], projectRoot),
    ).toThrow(/not a directory/);
  });

  it("accepts readOnly: true on type: bind", () => {
    const src = join(projectRoot, "bind-ro");
    mkdirSync(src);
    const [m] = parseMounts(
      [{ source: src, target: "/sandbox/.openlock/ro", type: "bind", readOnly: true }],
      projectRoot,
    );
    expect(m?.readOnly).toBe(true);
  });

  it("accepts readOnly: false on type: bind (or absent)", () => {
    const src = join(projectRoot, "bind-rw");
    mkdirSync(src);
    const ms = parseMounts(
      [
        { source: src, target: "/sandbox/.openlock/a", type: "bind", readOnly: false },
        { source: src, target: "/sandbox/.openlock/b", type: "bind" },
      ],
      projectRoot,
    );
    expect(ms[0]?.readOnly).toBe(false);
    expect(ms[1]?.readOnly).toBeUndefined();
  });

  it("rejects readOnly on type: copy-once", () => {
    const src = join(projectRoot, "co");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/x", type: "copy-once", readOnly: true }],
        projectRoot,
      ),
    ).toThrow(/readOnly is only valid on type: bind/);
  });

  it("rejects readOnly on type: copy-refresh", () => {
    const src = join(projectRoot, "cr");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/x", type: "copy-refresh", readOnly: true }],
        projectRoot,
      ),
    ).toThrow(/readOnly is only valid on type: bind/);
  });

  it("rejects readOnly on type: git-bundle", () => {
    const src = join(projectRoot, "gb");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/repo", type: "git-bundle", readOnly: true }],
        projectRoot,
      ),
    ).toThrow(/readOnly is only valid on type: bind/);
  });

  it("rejects non-boolean readOnly", () => {
    const src = join(projectRoot, "bind");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
        [{ source: src, target: "/sandbox/.openlock/x", type: "bind", readOnly: "yes" as any }],
        projectRoot,
      ),
    ).toThrow(/readOnly must be a boolean/);
  });

  it("bind: accepts target outside /sandbox/.openlock/", () => {
    const src = join(projectRoot, "bind-out");
    mkdirSync(src);
    const [m] = parseMounts(
      [{ source: src, target: "/sandbox/extras", type: "bind" }],
      projectRoot,
    );
    expect(m?.target).toBe("/sandbox/extras");
    expect(m?.type).toBe("bind");
  });

  it("bind: accepts target /sandbox/repo (workdir override)", () => {
    const src = join(projectRoot, "bind-repo");
    mkdirSync(src);
    const [m] = parseMounts([{ source: src, target: "/sandbox/repo", type: "bind" }], projectRoot);
    expect(m?.target).toBe("/sandbox/repo");
    expect(m?.type).toBe("bind");
  });

  it("bind: rejects target reserved repo.bundle", () => {
    const src = join(projectRoot, "bind-rb");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/repo.bundle", type: "bind" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name 'repo\.bundle'/);
  });

  it("bind: rejects target reserved .gitconfig", () => {
    const src = join(projectRoot, "bind-gc");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/.gitconfig", type: "bind" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name '\.gitconfig'/);
  });

  it("bind: rejects target reserved bundles", () => {
    const src = join(projectRoot, "bind-bn");
    mkdirSync(src);
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/bundles", type: "bind" }],
        projectRoot,
      ),
    ).toThrow(/conflicts with openlock-internal name 'bundles'/);
  });

  it("bind: rejects target with '..' segment", () => {
    const src = join(projectRoot, "bind-dd");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/sandbox/../etc", type: "bind" }], projectRoot),
    ).toThrow(/must not contain '\.\.'/);
  });

  it("bind: rejects non-absolute target", () => {
    const src = join(projectRoot, "bind-rel");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "sandbox/extras", type: "bind" }], projectRoot),
    ).toThrow(/must be absolute/);
  });

  it("git-bundle: accepts target /sandbox/repo", () => {
    const src = join(projectRoot, "gb-repo");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    const [m] = parseMounts(
      [{ source: src, target: "/sandbox/repo", type: "git-bundle" }],
      projectRoot,
    );
    expect(m?.target).toBe("/sandbox/repo");
  });

  it("git-bundle: accepts target /sandbox/extra-repo", () => {
    const src = join(projectRoot, "gb-extra");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    const [m] = parseMounts(
      [{ source: src, target: "/sandbox/extra-repo", type: "git-bundle" }],
      projectRoot,
    );
    expect(m?.target).toBe("/sandbox/extra-repo");
  });

  it("git-bundle: rejects target under /sandbox/.openlock/", () => {
    const src = join(projectRoot, "gb-bad");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    expect(() =>
      parseMounts(
        [{ source: src, target: "/sandbox/.openlock/some-repo", type: "git-bundle" }],
        projectRoot,
      ),
    ).toThrow(/git-bundle target must not be under \/sandbox\/\.openlock\//);
  });

  it("rejects copy-once targeting /sandbox/repo", () => {
    const src = join(projectRoot, "co-repo");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/sandbox/repo", type: "copy-once" }], projectRoot),
    ).toThrow(/\/sandbox\/repo not supported with type 'copy-once'/);
  });

  it("rejects copy-refresh targeting /sandbox/repo", () => {
    const src = join(projectRoot, "cr-repo");
    mkdirSync(src);
    expect(() =>
      parseMounts([{ source: src, target: "/sandbox/repo", type: "copy-refresh" }], projectRoot),
    ).toThrow(/\/sandbox\/repo not supported with type 'copy-refresh'/);
  });

  it("accepts zero workdir mounts (no mount targets /sandbox/repo)", () => {
    const src = join(projectRoot, "no-wd");
    mkdirSync(src);
    const ms = parseMounts(
      [{ source: src, target: "/sandbox/.openlock/x", type: "copy-once" }],
      projectRoot,
    );
    expect(ms).toHaveLength(1);
    expect(ms.find((m) => m.target === "/sandbox/repo")).toBeUndefined();
  });
});

describe("workdirMount", () => {
  it("returns undefined when no mount targets /sandbox/repo", () => {
    const src = join(projectRoot, "x");
    mkdirSync(src);
    const mounts: Mount[] = [{ source: src, target: "/sandbox/.openlock/x", type: "copy-once" }];
    expect(workdirMount(mounts)).toBeUndefined();
  });

  it("returns the bind mount when it targets /sandbox/repo", () => {
    const src = join(projectRoot, "bind-wd");
    mkdirSync(src);
    const m: Mount = { source: src, target: "/sandbox/repo", type: "bind" };
    expect(workdirMount([m])).toEqual(m);
  });

  it("returns the git-bundle mount when it targets /sandbox/repo", () => {
    const src = join(projectRoot, "gb-wd");
    mkdirSync(src);
    const m: Mount = { source: src, target: "/sandbox/repo", type: "git-bundle" };
    expect(workdirMount([m])).toEqual(m);
  });
});

describe("stagingPathFor", () => {
  it("strips the /sandbox/.openlock/ prefix and returns the staging-relative path", () => {
    expect(stagingPathFor("/sandbox/.openlock/skills")).toBe("skills");
    expect(stagingPathFor("/sandbox/.openlock/scratch")).toBe("scratch");
  });

  it("throws when target is not under /sandbox/.openlock/", () => {
    expect(() => stagingPathFor("/etc/passwd")).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("throws when target contains a .. segment", () => {
    expect(() => stagingPathFor("/sandbox/a/../b")).toThrow(/must not contain '\.\.'/);
  });
});

describe("stageMounts", () => {
  it("copies each mount's source into staging at the staging-relative path", () => {
    const src = join(projectRoot, "seed");
    mkdirSync(src);
    writeFileSync(join(src, "file.txt"), "hello");
    const staging = mkdtempSync(join(tmpdir(), "openlock-stage-"));
    try {
      const mounts: Mount[] = [
        { source: src, target: "/sandbox/.openlock/skills", type: "copy-once" },
      ];
      stageMounts(staging, mounts);
      expect(fsReadFileSync(join(staging, "skills/file.txt"), "utf-8")).toBe("hello");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it("dereferences symlinks (no symlinks in staged output)", () => {
    const src = join(projectRoot, "seed");
    mkdirSync(src);
    writeFileSync(join(src, "real.txt"), "real-content");
    symlinkSync(join(src, "real.txt"), join(src, "linked.txt"));
    const staging = mkdtempSync(join(tmpdir(), "openlock-stage-"));
    try {
      stageMounts(staging, [
        { source: src, target: "/sandbox/.openlock/scratch", type: "copy-once" },
      ]);
      const lst = lstatSync(join(staging, "scratch/linked.txt"));
      expect(lst.isSymbolicLink()).toBe(false);
      expect(fsReadFileSync(join(staging, "scratch/linked.txt"), "utf-8")).toBe("real-content");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it("creates parent dirs as needed", () => {
    const src = join(projectRoot, "seed");
    mkdirSync(src);
    writeFileSync(join(src, "x"), "");
    const staging = mkdtempSync(join(tmpdir(), "openlock-stage-"));
    try {
      stageMounts(staging, [
        { source: src, target: "/sandbox/.openlock/a/b/c/d", type: "copy-once" },
      ]);
      expect(fsReadFileSync(join(staging, "a/b/c/d/x"), "utf-8")).toBe("");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it("skips bind entries (no cp)", () => {
    const src = join(projectRoot, "bind-src");
    mkdirSync(src);
    writeFileSync(join(src, "file.txt"), "should not be copied");
    const staging = mkdtempSync(join(tmpdir(), "openlock-stage-"));
    try {
      stageMounts(staging, [{ source: src, target: "/sandbox/.openlock/x", type: "bind" }]);
      // No directory created under staging for bind targets.
      expect(existsSync(join(staging, "x"))).toBe(false);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it("skips git-bundle entries (no cp)", () => {
    const src = join(projectRoot, "gb");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    const staging = mkdtempSync(join(tmpdir(), "openlock-stage-"));
    try {
      stageMounts(staging, [{ source: src, target: "/sandbox/repo", type: "git-bundle" }]);
      expect(existsSync(join(staging, "repo"))).toBe(false);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

describe("bindMountArgs", () => {
  it("returns [] when no bind mounts", () => {
    const src = join(projectRoot, "x");
    mkdirSync(src);
    const ms = parseMounts(
      [{ source: src, target: "/sandbox/.openlock/x", type: "copy-once" }],
      projectRoot,
    );
    expect(bindMountArgs(ms)).toEqual([]);
  });

  it("emits --volume host:container for one bind without readOnly", () => {
    const src = join(projectRoot, "x");
    mkdirSync(src);
    const ms = parseMounts(
      [{ source: src, target: "/sandbox/.openlock/x", type: "bind" }],
      projectRoot,
    );
    expect(bindMountArgs(ms)).toEqual(["--volume", `${src}:/sandbox/.openlock/x`]);
  });

  it("emits --volume host:container:ro for one bind with readOnly: true", () => {
    const src = join(projectRoot, "x");
    mkdirSync(src);
    const ms = parseMounts(
      [{ source: src, target: "/sandbox/.openlock/x", type: "bind", readOnly: true }],
      projectRoot,
    );
    expect(bindMountArgs(ms)).toEqual(["--volume", `${src}:/sandbox/.openlock/x:ro`]);
  });

  it("emits multiple --volume args for multiple bind entries", () => {
    const a = join(projectRoot, "a");
    const b = join(projectRoot, "b");
    mkdirSync(a);
    mkdirSync(b);
    const ms = parseMounts(
      [
        { source: a, target: "/sandbox/.openlock/a", type: "bind" },
        { source: b, target: "/home/sandbox/b", type: "bind", readOnly: true },
      ],
      projectRoot,
    );
    expect(bindMountArgs(ms)).toEqual([
      "--volume",
      `${a}:/sandbox/.openlock/a`,
      "--volume",
      `${b}:/home/sandbox/b:ro`,
    ]);
  });

  it("skips non-bind entries", () => {
    const a = join(projectRoot, "a");
    const b = join(projectRoot, "b");
    mkdirSync(a);
    mkdirSync(b);
    const ms = parseMounts(
      [
        { source: a, target: "/sandbox/.openlock/a", type: "copy-once" },
        { source: b, target: "/sandbox/.openlock/b", type: "bind" },
      ],
      projectRoot,
    );
    expect(bindMountArgs(ms)).toEqual(["--volume", `${b}:/sandbox/.openlock/b`]);
  });
});

describe("gitBundleMounts", () => {
  function makeGitRepo(p: string) {
    mkdirSync(p);
    mkdirSync(join(p, ".git"));
    writeFileSync(join(p, ".git/HEAD"), "ref: refs/heads/main\n");
  }

  it("returns [] when no git-bundle mounts", () => {
    expect(gitBundleMounts([])).toEqual([]);
  });

  it("returns the workdir git-bundle mount", () => {
    const src = join(projectRoot, "repo");
    makeGitRepo(src);
    const ms = parseMounts(
      [{ source: src, target: "/sandbox/repo", type: "git-bundle" }],
      projectRoot,
    );
    expect(gitBundleMounts(ms).map((m) => m.target)).toEqual(["/sandbox/repo"]);
  });

  it("returns multiple git-bundle mounts (workdir + extras)", () => {
    const a = join(projectRoot, "alpha");
    const b = join(projectRoot, "beta");
    makeGitRepo(a);
    makeGitRepo(b);
    const ms = parseMounts(
      [
        { source: a, target: "/sandbox/repo", type: "git-bundle" },
        { source: b, target: "/sandbox/extra-repo", type: "git-bundle" },
      ],
      projectRoot,
    );
    expect(gitBundleMounts(ms).map((m) => m.target)).toEqual([
      "/sandbox/repo",
      "/sandbox/extra-repo",
    ]);
  });

  it("rejects two git-bundle mounts whose source basenames collide", () => {
    const a = join(projectRoot, "outer/app");
    const b = join(projectRoot, "inner/app");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    mkdirSync(join(a, ".git"));
    mkdirSync(join(b, ".git"));
    writeFileSync(join(a, ".git/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(b, ".git/HEAD"), "ref: refs/heads/main\n");
    expect(() =>
      parseMounts(
        [
          { source: a, target: "/sandbox/repo", type: "git-bundle" },
          { source: b, target: "/sandbox/extra-repo", type: "git-bundle" },
        ],
        projectRoot,
      ),
    ).toThrow(/source basename 'app' collides between git-bundle mounts/);
  });
});
