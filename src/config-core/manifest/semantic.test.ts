import { describe, expect, it } from "bun:test";
import { validateManifestSemantics } from "./semantic";

function msgs(doc: Record<string, unknown>): string[] {
  return validateManifestSemantics(doc).map((i) => i.message);
}

describe("validateManifestSemantics", () => {
  it("passes a valid copy-once mount", () => {
    expect(
      validateManifestSemantics({
        mounts: [{ source: "s", target: "/sandbox/.openlock/x", type: "copy-once" }],
      }),
    ).toEqual([]);
  });

  it("rejects a non-absolute target", () => {
    expect(msgs({ mounts: [{ source: "s", target: "sandbox/x", type: "copy-once" }] })[0]).toMatch(
      /must be absolute/,
    );
  });

  it("rejects a '..' segment in target", () => {
    expect(msgs({ mounts: [{ source: "s", target: "/sandbox/../etc", type: "bind" }] })[0]).toMatch(
      /must not contain '\.\.'/,
    );
  });

  it("rejects a reserved openlock-internal target name", () => {
    expect(
      msgs({
        mounts: [{ source: "s", target: "/sandbox/.openlock/bundles", type: "copy-once" }],
      })[0],
    ).toMatch(/conflicts with openlock-internal name 'bundles'/);
  });

  it("rejects copy-once targeting /sandbox/repo", () => {
    expect(
      msgs({ mounts: [{ source: "s", target: "/sandbox/repo", type: "copy-once" }] })[0],
    ).toMatch(/\/sandbox\/repo not supported with type 'copy-once'/);
  });

  it("rejects copy-once outside /sandbox/.openlock/", () => {
    expect(
      msgs({ mounts: [{ source: "s", target: "/etc/passwd", type: "copy-once" }] })[0],
    ).toMatch(/under \/sandbox\/\.openlock\//);
  });

  it("rejects git-bundle under /sandbox/.openlock/", () => {
    expect(
      msgs({ mounts: [{ source: "s", target: "/sandbox/.openlock/repo", type: "git-bundle" }] })[0],
    ).toMatch(/git-bundle target must not be under/);
  });

  it("allows bind anywhere outside reserved names", () => {
    expect(
      validateManifestSemantics({
        mounts: [{ source: "s", target: "/sandbox/extras", type: "bind" }],
      }),
    ).toEqual([]);
  });

  it("rejects duplicate targets", () => {
    expect(
      msgs({
        mounts: [
          { source: "a", target: "/sandbox/.openlock/x", type: "copy-once" },
          { source: "b", target: "/sandbox/.openlock/x", type: "copy-refresh" },
        ],
      }),
    ).toContain("duplicate target /sandbox/.openlock/x");
  });

  it("rejects colliding git-bundle source basenames", () => {
    expect(
      msgs({
        mounts: [
          { source: "outer/app", target: "/sandbox/repo", type: "git-bundle" },
          { source: "inner/app", target: "/sandbox/extra-repo", type: "git-bundle" },
        ],
      }).some((m) => /source basename 'app' collides between git-bundle mounts/.test(m)),
    ).toBe(true);
  });
});
