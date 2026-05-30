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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mount, parseManifest } from "../config-core";
import {
  bindMountArgs,
  gitBundleMounts,
  stageMounts,
  stagingPathFor,
  workdirMount,
} from "./mounts";

function mk(raw: unknown[]): Mount[] {
  return parseManifest({ mounts: raw }, projectRoot).mounts;
}

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "openlock-mounts-test-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
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
    const ms = mk([{ source: src, target: "/sandbox/.openlock/x", type: "copy-once" }]);
    expect(bindMountArgs(ms)).toEqual([]);
  });

  it("emits --volume host:container for one bind without readOnly", () => {
    const src = join(projectRoot, "x");
    mkdirSync(src);
    const ms = mk([{ source: src, target: "/sandbox/.openlock/x", type: "bind" }]);
    expect(bindMountArgs(ms)).toEqual(["--volume", `${src}:/sandbox/.openlock/x`]);
  });

  it("emits --volume host:container:ro for one bind with readOnly: true", () => {
    const src = join(projectRoot, "x");
    mkdirSync(src);
    const ms = mk([{ source: src, target: "/sandbox/.openlock/x", type: "bind", readOnly: true }]);
    expect(bindMountArgs(ms)).toEqual(["--volume", `${src}:/sandbox/.openlock/x:ro`]);
  });

  it("emits multiple --volume args for multiple bind entries", () => {
    const a = join(projectRoot, "a");
    const b = join(projectRoot, "b");
    mkdirSync(a);
    mkdirSync(b);
    const ms = mk([
      { source: a, target: "/sandbox/.openlock/a", type: "bind" },
      { source: b, target: "/home/sandbox/b", type: "bind", readOnly: true },
    ]);
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
    const ms = mk([
      { source: a, target: "/sandbox/.openlock/a", type: "copy-once" },
      { source: b, target: "/sandbox/.openlock/b", type: "bind" },
    ]);
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
    const ms = mk([{ source: src, target: "/sandbox/repo", type: "git-bundle" }]);
    expect(gitBundleMounts(ms).map((m) => m.target)).toEqual(["/sandbox/repo"]);
  });

  it("returns multiple git-bundle mounts (workdir + extras)", () => {
    const a = join(projectRoot, "alpha");
    const b = join(projectRoot, "beta");
    makeGitRepo(a);
    makeGitRepo(b);
    const ms = mk([
      { source: a, target: "/sandbox/repo", type: "git-bundle" },
      { source: b, target: "/sandbox/extra-repo", type: "git-bundle" },
    ]);
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
      mk([
        { source: a, target: "/sandbox/repo", type: "git-bundle" },
        { source: b, target: "/sandbox/extra-repo", type: "git-bundle" },
      ]),
    ).toThrow(/source basename 'app' collides between git-bundle mounts/);
  });
});
