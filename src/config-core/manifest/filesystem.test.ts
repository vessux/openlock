import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSource, validateManifestFilesystem } from "./filesystem";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openlock-fs-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateManifestFilesystem", () => {
  it("reports a missing source as a filesystem issue", () => {
    const issues = validateManifestFilesystem(
      { mounts: [{ source: "nope", target: "/sandbox/.openlock/x", type: "copy-once" }] },
      root,
    );
    expect(issues[0]?.severity).toBe("filesystem");
    expect(issues[0]?.message).toMatch(/does not exist/);
  });

  it("reports a file source for a directory-requiring type", () => {
    const f = join(root, "file");
    writeFileSync(f, "x");
    const issues = validateManifestFilesystem(
      { mounts: [{ source: f, target: "/sandbox/.openlock/x", type: "copy-once" }] },
      root,
    );
    expect(issues[0]?.message).toMatch(/not a directory/);
  });

  it("reports a non-git source for git-bundle", () => {
    const d = join(root, "d");
    mkdirSync(d);
    const issues = validateManifestFilesystem(
      { mounts: [{ source: d, target: "/sandbox/repo", type: "git-bundle" }] },
      root,
    );
    expect(issues[0]?.message).toMatch(/not a git working tree/);
  });

  it("passes when sources exist and match the type", () => {
    const d = join(root, "ok");
    mkdirSync(d);
    expect(
      validateManifestFilesystem(
        { mounts: [{ source: "ok", target: "/sandbox/.openlock/x", type: "copy-once" }] },
        root,
      ),
    ).toEqual([]);
  });
});

describe("resolveSource", () => {
  it("resolves a relative source against projectRoot", () => {
    expect(resolveSource("/proj", "sub")).toBe("/proj/sub");
  });
  it("keeps an absolute source", () => {
    expect(resolveSource("/proj", "/abs")).toBe("/abs");
  });
  it("expands ~ to homedir", () => {
    expect(resolveSource("/proj", "~/foo")).toBe(join(homedir(), "foo"));
  });
});
