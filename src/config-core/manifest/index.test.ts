import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { lintManifest, parseManifest } from "./index";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlock-manifest-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lintManifest", () => {
  it("accepts an empty manifest", () => {
    expect(lintManifest({}, root, { offline: true })).toEqual([]);
  });

  it("reports a YAML parse error when given a bad string", () => {
    const issues = lintManifest("a: b: c\n", root, { offline: true });
    expect(issues[0]?.message).toMatch(/YAML parse error/);
  });

  it("flags a leftover caps key as an unknown-key error", () => {
    const issues = lintManifest("caps: [js]\n", root, { offline: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toMatch(/unknown key "caps"/);
  });

  it("short-circuits: a schema error suppresses semantic/filesystem", () => {
    const issues = lintManifest({ mounts: [{ source: "s", target: "/x", type: "bad" }] }, root, {
      offline: false,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/unknown type 'bad'/);
  });

  it("offline:true skips filesystem checks", () => {
    const doc = {
      mounts: [{ source: "nope", target: "/sandbox/.openlock/x", type: "copy-once" }],
    };
    expect(lintManifest(doc, root, { offline: true })).toEqual([]);
    expect(lintManifest(doc, root, { offline: false })[0]?.severity).toBe("filesystem");
  });

  it("collects semantic + filesystem issues together (offline:false)", () => {
    const doc = { mounts: [{ source: "nope", target: "/etc/x", type: "copy-once" }] };
    const issues = lintManifest(doc, root, { offline: false });
    expect(issues.map((i) => i.severity).sort()).toEqual(["error", "filesystem"]);
  });

  it("accepts a valid YAML string manifest", () => {
    expect(lintManifest("mounts: []\nargs: []\n", root, { offline: true })).toEqual([]);
  });
});

describe("parseManifest", () => {
  it("returns a typed config with resolved sources", () => {
    mkdirSync(join(root, "seed"));
    const cfg = parseManifest(
      {
        mounts: [{ source: "seed", target: "/sandbox/.openlock/x", type: "copy-once" }],
        args: ["--x"],
        env: { A: "1" },
      },
      root,
    );
    expect(cfg.mounts[0]?.source).toBe(join(root, "seed"));
    expect(cfg.args).toEqual(["--x"]);
    expect(cfg.env).toEqual({ A: "1" });
  });

  it("defaults to empty arrays/object for an empty manifest", () => {
    expect(parseManifest({}, root)).toEqual({ mounts: [], args: [], env: {} });
  });

  it("throws on an unknown key (caps)", () => {
    expect(() => parseManifest({ caps: ["js"] }, root)).toThrow(/unknown key "caps"/);
  });

  it("throws on a missing source (filesystem)", () => {
    expect(() =>
      parseManifest(
        { mounts: [{ source: "nope", target: "/sandbox/.openlock/x", type: "copy-once" }] },
        root,
      ),
    ).toThrow(/does not exist/);
  });

  it("throws a bad-target message matching the prior runtime", () => {
    mkdirSync(join(root, "s"));
    expect(() =>
      parseManifest({ mounts: [{ source: "s", target: "/etc/passwd", type: "copy-once" }] }, root),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("builds config from a YAML string input", () => {
    const cfg = parseManifest("args:\n  - --x\nenv:\n  A: '1'\n", root);
    expect(cfg).toEqual({ mounts: [], args: ["--x"], env: { A: "1" } });
  });
});

describe("parseManifest (ported parseMounts cases)", () => {
  it("[ported] returns [] when raw is undefined", () => {
    expect(parseManifest({}, root).mounts).toEqual([]);
  });

  it("[ported] returns [] when raw is an empty list", () => {
    expect(parseManifest({ mounts: [] }, root).mounts).toEqual([]);
  });

  it("[ported] throws when raw is not a list", () => {
    expect(() => parseManifest({ mounts: {} }, root)).toThrow(/'mounts' must be a list/);
  });

  it("[ported] resolves a relative source path against projectRoot", () => {
    const src = join(root, "seeds");
    mkdirSync(src);
    const [m] = parseManifest(
      { mounts: [{ source: "seeds", target: "/sandbox/.openlock/x", type: "copy-once" }] },
      root,
    ).mounts;
    expect(m?.source).toBe(src);
  });

  it("[ported] expands ~ in source", () => {
    const testDir = join(homedir(), ".openlock-mounts-test-tmp");
    mkdirSync(testDir, { recursive: true });
    try {
      const [m] = parseManifest(
        {
          mounts: [
            {
              source: "~/.openlock-mounts-test-tmp",
              target: "/sandbox/.openlock/x",
              type: "copy-once",
            },
          ],
        },
        root,
      ).mounts;
      expect(m?.source).toBe(testDir);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("[ported] accepts absolute source", () => {
    const src = join(root, "abs");
    mkdirSync(src);
    const [m] = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/.openlock/x", type: "copy-once" }] },
      root,
    ).mounts;
    expect(m?.source).toBe(src);
  });

  it("[ported] throws when source is missing or not a string", () => {
    expect(() =>
      parseManifest({ mounts: [{ target: "/sandbox/.openlock/x", type: "copy-once" }] }, root),
    ).toThrow(/source/);
  });

  it("[ported] throws when source does not exist", () => {
    expect(() =>
      parseManifest(
        {
          mounts: [
            {
              source: "/nope/does/not/exist",
              target: "/sandbox/.openlock/x",
              type: "copy-once",
            },
          ],
        },
        root,
      ),
    ).toThrow(/source.*does not exist/);
  });

  it("[ported] throws when source is a file, not a directory", () => {
    const f = join(root, "file");
    writeFileSync(f, "x");
    expect(() =>
      parseManifest(
        { mounts: [{ source: f, target: "/sandbox/.openlock/x", type: "copy-once" }] },
        root,
      ),
    ).toThrow(/source.*not a directory/);
  });

  it("[ported] throws when target is missing", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() => parseManifest({ mounts: [{ source: src, type: "copy-once" }] }, root)).toThrow(
      /target/,
    );
  });

  it("[ported] throws when target is not absolute", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest({ mounts: [{ source: src, target: "sandbox/x", type: "copy-once" }] }, root),
    ).toThrow(/absolute/);
  });

  it("[ported] throws when target is not under /sandbox/.openlock/", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest({ mounts: [{ source: src, target: "/etc/passwd", type: "copy-once" }] }, root),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("[ported] throws when target is under /sandbox/ but not under /sandbox/.openlock/", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/scratch", type: "copy-once" }] },
        root,
      ),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("[ported] throws when target equals /sandbox/.openlock or /sandbox/.openlock/", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/.openlock", type: "copy-once" }] },
        root,
      ),
    ).toThrow(/under \/sandbox\/\.openlock\//);
  });

  it("[ported] throws when target contains a .. segment", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/../etc/passwd", type: "copy-once" }] },
        root,
      ),
    ).toThrow(/must not contain '\.\.'/);
  });

  it("[ported] rejects /sandbox/.openlock/../etc/passwd (prefix-bypass via ..)", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [{ source: src, target: "/sandbox/.openlock/../etc/passwd", type: "copy-once" }],
        },
        root,
      ),
    ).toThrow(/must not contain '\.\.'/);
  });

  it("[ported] throws when target's top segment collides with openlock-internal name (.gitconfig)", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [{ source: src, target: "/sandbox/.openlock/.gitconfig", type: "copy-once" }],
        },
        root,
      ),
    ).toThrow(/conflicts with openlock-internal name '\.gitconfig'/);
  });

  it("[ported] also catches collision when reserved name is the prefix of a deeper path", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [{ source: src, target: "/sandbox/.openlock/bundles/sub", type: "copy-once" }],
        },
        root,
      ),
    ).toThrow(/conflicts with openlock-internal name 'bundles'/);
  });

  it("[ported] throws when target's top segment is reserved 'bundles' (copy-once)", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [{ source: src, target: "/sandbox/.openlock/bundles", type: "copy-once" }],
        },
        root,
      ),
    ).toThrow(/conflicts with openlock-internal name 'bundles'/);
  });

  it("[ported] throws when two mounts share a target", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    expect(() =>
      parseManifest(
        {
          mounts: [
            { source: a, target: "/sandbox/.openlock/x", type: "copy-once" },
            { source: b, target: "/sandbox/.openlock/x", type: "copy-refresh" },
          ],
        },
        root,
      ),
    ).toThrow(/duplicate target/);
  });

  it("[ported] throws when type is missing", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest({ mounts: [{ source: src, target: "/sandbox/.openlock/x" }] }, root),
    ).toThrow(/type/);
  });

  it("[ported] throws when type is unknown", () => {
    const src = join(root, "s");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/.openlock/x", type: "no-such-type" }] },
        root,
      ),
    ).toThrow(/unknown type/);
  });

  it("[ported] accepts type copy-once and copy-refresh", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const ms = parseManifest(
      {
        mounts: [
          { source: a, target: "/sandbox/.openlock/a", type: "copy-once" },
          { source: b, target: "/sandbox/.openlock/b", type: "copy-refresh" },
        ],
      },
      root,
    ).mounts;
    expect(ms.map((m) => m.type)).toEqual(["copy-once", "copy-refresh"]);
  });

  it("[ported] accepts type: bind with a directory source", () => {
    const src = join(root, "bind-dir");
    mkdirSync(src);
    const [m] = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/.openlock/bound", type: "bind" }] },
      root,
    ).mounts;
    expect(m?.type).toBe("bind");
    expect(m?.source).toBe(src);
  });

  it("[ported] accepts type: bind with a file source", () => {
    const f = join(root, "bind-file");
    writeFileSync(f, "hello");
    const [m] = parseManifest(
      { mounts: [{ source: f, target: "/sandbox/.openlock/file", type: "bind" }] },
      root,
    ).mounts;
    expect(m?.type).toBe("bind");
    expect(m?.source).toBe(f);
  });

  it("[ported] accepts type: git-bundle with a git working tree source", () => {
    const src = join(root, "repo");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    const [m] = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/repo", type: "git-bundle" }] },
      root,
    ).mounts;
    expect(m?.type).toBe("git-bundle");
    expect(m?.source).toBe(src);
  });

  it("[ported] rejects type: git-bundle with non-git directory source", () => {
    const src = join(root, "not-a-repo");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/repo", type: "git-bundle" }] },
        root,
      ),
    ).toThrow(/not a git working tree/);
  });

  it("[ported] rejects type: git-bundle with file source", () => {
    const f = join(root, "file");
    writeFileSync(f, "");
    expect(() =>
      parseManifest({ mounts: [{ source: f, target: "/sandbox/repo", type: "git-bundle" }] }, root),
    ).toThrow(/not a directory/);
  });

  it("[ported] accepts readOnly: true on type: bind", () => {
    const src = join(root, "bind-ro");
    mkdirSync(src);
    const [m] = parseManifest(
      {
        mounts: [{ source: src, target: "/sandbox/.openlock/ro", type: "bind", readOnly: true }],
      },
      root,
    ).mounts;
    expect(m?.readOnly).toBe(true);
  });

  it("[ported] accepts readOnly: false on type: bind (or absent)", () => {
    const src = join(root, "bind-rw");
    mkdirSync(src);
    const ms = parseManifest(
      {
        mounts: [
          { source: src, target: "/sandbox/.openlock/a", type: "bind", readOnly: false },
          { source: src, target: "/sandbox/.openlock/b", type: "bind" },
        ],
      },
      root,
    ).mounts;
    expect(ms[0]?.readOnly).toBe(false);
    expect(ms[1]?.readOnly).toBeUndefined();
  });

  it("[ported] rejects readOnly on type: copy-once", () => {
    const src = join(root, "co");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [
            {
              source: src,
              target: "/sandbox/.openlock/x",
              type: "copy-once",
              readOnly: true,
            },
          ],
        },
        root,
      ),
    ).toThrow(/readOnly is only valid on type: bind/);
  });

  it("[ported] rejects readOnly on type: copy-refresh", () => {
    const src = join(root, "cr");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [
            {
              source: src,
              target: "/sandbox/.openlock/x",
              type: "copy-refresh",
              readOnly: true,
            },
          ],
        },
        root,
      ),
    ).toThrow(/readOnly is only valid on type: bind/);
  });

  it("[ported] rejects readOnly on type: git-bundle", () => {
    const src = join(root, "gb");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    expect(() =>
      parseManifest(
        {
          mounts: [
            {
              source: src,
              target: "/sandbox/repo",
              type: "git-bundle",
              readOnly: true,
            },
          ],
        },
        root,
      ),
    ).toThrow(/readOnly is only valid on type: bind/);
  });

  it("[ported] rejects non-boolean readOnly", () => {
    const src = join(root, "bind");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [
            {
              source: src,
              target: "/sandbox/.openlock/x",
              type: "bind",
              // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
              readOnly: "yes" as any,
            },
          ],
        },
        root,
      ),
    ).toThrow(/readOnly must be a boolean/);
  });

  it("[ported] bind: accepts target outside /sandbox/.openlock/", () => {
    const src = join(root, "bind-out");
    mkdirSync(src);
    const [m] = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/extras", type: "bind" }] },
      root,
    ).mounts;
    expect(m?.target).toBe("/sandbox/extras");
    expect(m?.type).toBe("bind");
  });

  it("[ported] bind: accepts target /sandbox/repo (workdir override)", () => {
    const src = join(root, "bind-repo");
    mkdirSync(src);
    const [m] = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/repo", type: "bind" }] },
      root,
    ).mounts;
    expect(m?.target).toBe("/sandbox/repo");
    expect(m?.type).toBe("bind");
  });

  it("[ported] bind: rejects target reserved .gitconfig", () => {
    const src = join(root, "bind-gc");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        {
          mounts: [{ source: src, target: "/sandbox/.openlock/.gitconfig", type: "bind" }],
        },
        root,
      ),
    ).toThrow(/conflicts with openlock-internal name '\.gitconfig'/);
  });

  it("[ported] bind: rejects target reserved bundles", () => {
    const src = join(root, "bind-bn");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/.openlock/bundles", type: "bind" }] },
        root,
      ),
    ).toThrow(/conflicts with openlock-internal name 'bundles'/);
  });

  it("[ported] bind: rejects target with '..' segment", () => {
    const src = join(root, "bind-dd");
    mkdirSync(src);
    expect(() =>
      parseManifest({ mounts: [{ source: src, target: "/sandbox/../etc", type: "bind" }] }, root),
    ).toThrow(/must not contain '\.\.'/);
  });

  it("[ported] bind: rejects non-absolute target", () => {
    const src = join(root, "bind-rel");
    mkdirSync(src);
    expect(() =>
      parseManifest({ mounts: [{ source: src, target: "sandbox/extras", type: "bind" }] }, root),
    ).toThrow(/must be absolute/);
  });

  it("[ported] git-bundle: accepts target /sandbox/repo", () => {
    const src = join(root, "gb-repo");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    const [m] = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/repo", type: "git-bundle" }] },
      root,
    ).mounts;
    expect(m?.target).toBe("/sandbox/repo");
  });

  it("[ported] git-bundle: accepts target /sandbox/extra-repo", () => {
    const src = join(root, "gb-extra");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    const [m] = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/extra-repo", type: "git-bundle" }] },
      root,
    ).mounts;
    expect(m?.target).toBe("/sandbox/extra-repo");
  });

  it("[ported] git-bundle: rejects target under /sandbox/.openlock/", () => {
    const src = join(root, "gb-bad");
    mkdirSync(src);
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git/HEAD"), "ref: refs/heads/main\n");
    expect(() =>
      parseManifest(
        {
          mounts: [
            {
              source: src,
              target: "/sandbox/.openlock/some-repo",
              type: "git-bundle",
            },
          ],
        },
        root,
      ),
    ).toThrow(/git-bundle target must not be under \/sandbox\/\.openlock\//);
  });

  it("[ported] rejects copy-once targeting /sandbox/repo", () => {
    const src = join(root, "co-repo");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/repo", type: "copy-once" }] },
        root,
      ),
    ).toThrow(/\/sandbox\/repo not supported with type 'copy-once'/);
  });

  it("[ported] rejects copy-refresh targeting /sandbox/repo", () => {
    const src = join(root, "cr-repo");
    mkdirSync(src);
    expect(() =>
      parseManifest(
        { mounts: [{ source: src, target: "/sandbox/repo", type: "copy-refresh" }] },
        root,
      ),
    ).toThrow(/\/sandbox\/repo not supported with type 'copy-refresh'/);
  });

  it("[ported] accepts zero workdir mounts (no mount targets /sandbox/repo)", () => {
    const src = join(root, "no-wd");
    mkdirSync(src);
    const ms = parseManifest(
      { mounts: [{ source: src, target: "/sandbox/.openlock/x", type: "copy-once" }] },
      root,
    ).mounts;
    expect(ms).toHaveLength(1);
    expect(ms.find((m) => m.target === "/sandbox/repo")).toBeUndefined();
  });

  it("[ported] rejects two git-bundle mounts whose source basenames collide", () => {
    const a = join(root, "outer/app");
    const b = join(root, "inner/app");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    mkdirSync(join(a, ".git"));
    mkdirSync(join(b, ".git"));
    writeFileSync(join(a, ".git/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(b, ".git/HEAD"), "ref: refs/heads/main\n");
    expect(() =>
      parseManifest(
        {
          mounts: [
            { source: a, target: "/sandbox/repo", type: "git-bundle" },
            { source: b, target: "/sandbox/extra-repo", type: "git-bundle" },
          ],
        },
        root,
      ),
    ).toThrow(/source basename 'app' collides between git-bundle mounts/);
  });
});
