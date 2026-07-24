import { describe, expect, it } from "bun:test";
import { mergeManifestDocs } from "./merge";

describe("mergeManifestDocs", () => {
  it("appends list keys (base ++ local)", () => {
    const merged = mergeManifestDocs(
      { args: ["--verbose"], mounts: [{ target: "/a" }], credentials: [{ name: "x" }] },
      { args: ["--model", "opus"], mounts: [{ target: "/b" }], credentials: [{ name: "y" }] },
    ) as Record<string, unknown>;
    expect(merged.args).toEqual(["--verbose", "--model", "opus"]);
    expect(merged.mounts).toEqual([{ target: "/a" }, { target: "/b" }]);
    expect(merged.credentials).toEqual([{ name: "x" }, { name: "y" }]);
  });

  it("merges env per key, local winning", () => {
    const merged = mergeManifestDocs(
      { env: { A: "1", B: "2" } },
      { env: { B: "9", C: "3" } },
    ) as Record<string, unknown>;
    expect(merged.env).toEqual({ A: "1", B: "9", C: "3" });
  });

  it("lets local replace scalar harness and carries unknown local keys", () => {
    const merged = mergeManifestDocs(
      { harness: "claude_code" },
      { harness: "opencode", bogus: true },
    ) as Record<string, unknown>;
    expect(merged.harness).toBe("opencode");
    expect(merged.bogus).toBe(true);
  });

  it("returns base unchanged when local is absent/empty", () => {
    const base = { args: ["--x"], env: { A: "1" } };
    expect(mergeManifestDocs(base, undefined)).toEqual(base);
    expect(mergeManifestDocs(base, {})).toEqual(base);
  });

  it("passes a one-sided list through unchanged", () => {
    expect((mergeManifestDocs({}, { mounts: [{ target: "/b" }] }) as Record<string, unknown>).mounts)
      .toEqual([{ target: "/b" }]);
    expect((mergeManifestDocs({ mounts: [{ target: "/a" }] }, {}) as Record<string, unknown>).mounts)
      .toEqual([{ target: "/a" }]);
  });

  it("lets a non-array local list win so validation can flag the bad type", () => {
    const merged = mergeManifestDocs({ args: ["--x"] }, { args: "oops" }) as Record<string, unknown>;
    expect(merged.args).toBe("oops");
  });
});
