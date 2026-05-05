import { describe, it, expect } from "bun:test";
import { buildImagesArgs } from "./build-images";

describe("buildImagesArgs", () => {
  it("produces podman build commands for core and language layers", () => {
    const cmds = buildImagesArgs({ noCache: false });
    expect(cmds.length).toBeGreaterThanOrEqual(4);
    expect(cmds[0]).toContain("podman");
    expect(cmds[0]).toContain("build");
    expect(cmds[0]).toContain("openlock-core:latest");
  });

  it("includes --no-cache when requested", () => {
    const cmds = buildImagesArgs({ noCache: true });
    for (const cmd of cmds) {
      expect(cmd).toContain("--no-cache");
    }
  });

  it("omits --no-cache when not requested", () => {
    const cmds = buildImagesArgs({ noCache: false });
    for (const cmd of cmds) {
      expect(cmd).not.toContain("--no-cache");
    }
  });

  it("builds in dependency order: core, then language layers", () => {
    const cmds = buildImagesArgs({ noCache: false });
    const tags = cmds.map((argv) => {
      const idx = argv.indexOf("-t");
      return argv[idx + 1];
    });
    expect(tags[0]).toBe("openlock-core:latest");
    const rest = tags.slice(1);
    expect(rest).toContain("openlock-core-js:latest");
    expect(rest).toContain("openlock-core-py:latest");
    expect(rest).toContain("openlock-core-js-py:latest");
  });
});
