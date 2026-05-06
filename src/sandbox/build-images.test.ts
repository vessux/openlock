import { describe, it, expect, mock } from "bun:test";
import { updateImages } from "./build-images";

describe("updateImages", () => {
  it("calls ensureImage once per cap permutation (4 total)", async () => {
    const calls: { tagPrefix: string; noCache: boolean }[] = [];
    const fakeEnsure = mock(async (args: { containerfileContent: string; tagPrefix: string; noCache?: boolean }) => {
      calls.push({ tagPrefix: args.tagPrefix, noCache: !!args.noCache });
      return { tag: `${args.tagPrefix}:fake`, built: true };
    });
    await updateImages({ noCache: false }, { ensureImage: fakeEnsure });
    expect(calls.length).toBe(4);
    const prefixes = calls.map((c) => c.tagPrefix).sort();
    expect(prefixes).toEqual([
      "openlock-core",
      "openlock-core-js",
      "openlock-core-js-py",
      "openlock-core-py",
    ]);
  });

  it("propagates noCache flag to ensureImage", async () => {
    const calls: { noCache: boolean }[] = [];
    const fakeEnsure = mock(async (args: { containerfileContent: string; tagPrefix: string; noCache?: boolean }) => {
      calls.push({ noCache: !!args.noCache });
      return { tag: `${args.tagPrefix}:fake`, built: true };
    });
    await updateImages({ noCache: true }, { ensureImage: fakeEnsure });
    expect(calls.every((c) => c.noCache === true)).toBe(true);
  });
});
