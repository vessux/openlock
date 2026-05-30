import { describe, expect, it } from "bun:test";
import { flagSchema, planInit, type FolderState } from "./init";

const S = (c: boolean, p: boolean, cf: boolean): FolderState => ({
  config: c,
  policy: p,
  containerfile: cf,
});

describe("init flagSchema", () => {
  it("declares --force, --harness, --help", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["force", "harness", "help"]);
  });
});

describe("planInit", () => {
  it("fresh when nothing is present", () => {
    expect(planInit(S(false, false, false), false)).toEqual({ kind: "fresh" });
  });

  it("complete when all present and no --force", () => {
    expect(planInit(S(true, true, true), false)).toEqual({ kind: "complete" });
  });

  it("gap-fill writes only the missing files", () => {
    expect(planInit(S(true, false, false), false)).toEqual({
      kind: "gapfill",
      write: ["policy.yaml", "Containerfile"],
      keep: ["config.yaml"],
    });
  });

  it("--force regenerates all three regardless of state", () => {
    expect(planInit(S(true, true, true), true)).toEqual({
      kind: "regenerate",
      write: ["config.yaml", "policy.yaml", "Containerfile"],
    });
  });
});
