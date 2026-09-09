import { describe, expect, it } from "bun:test";
import { buildDetachedCreateArgv } from "./sandbox-lifecycle";

describe("buildDetachedCreateArgv (fork v0.9.0 / #2726 canonical main process)", () => {
  it("emits --no-tty --detach -- sleep infinity as the main process, no --upload", () => {
    const argv = buildDetachedCreateArgv(["openshell"], {
      name: "sess",
      image: "img:tag",
      policy: "/tmp/policy.yaml",
      providers: [],
    });
    expect(argv).toEqual([
      "openshell",
      "sandbox",
      "create",
      "--name",
      "sess",
      "--from",
      "img:tag",
      "--policy",
      "/tmp/policy.yaml",
      "--no-tty",
      "--detach",
      "--",
      "sleep",
      "infinity",
    ]);
    expect(argv).not.toContain("--upload");
  });

  it("flattens multiple --provider flags in order", () => {
    const argv = buildDetachedCreateArgv(["openshell"], {
      name: "sess",
      image: "img:tag",
      policy: "/tmp/policy.yaml",
      providers: ["p1", "p2"],
    });
    const providerIdx = argv.indexOf("--provider");
    expect(providerIdx).toBeGreaterThan(-1);
    expect(argv.slice(providerIdx, providerIdx + 4)).toEqual([
      "--provider",
      "p1",
      "--provider",
      "p2",
    ]);
  });

  it("splices extra argv before --no-tty --detach", () => {
    const argv = buildDetachedCreateArgv(["openshell"], {
      name: "sess",
      image: "img:tag",
      policy: "/tmp/policy.yaml",
      providers: [],
      extra: ["--log-level", "debug"],
    });
    const extraIdx = argv.indexOf("--log-level");
    expect(extraIdx).toBeGreaterThan(-1);
    expect(argv[extraIdx + 1]).toBe("debug");
    expect(argv.slice(extraIdx + 2)).toEqual(["--no-tty", "--detach", "--", "sleep", "infinity"]);
  });
});
