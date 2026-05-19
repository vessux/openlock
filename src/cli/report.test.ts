import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENSHELL_FORK_TAG } from "../sandbox/fork-binaries";
import { report } from "./report";

describe("report()", () => {
  let stateDir = "";
  let outDir = "";
  let extractDir = "";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "openlock-report-state-"));
    outDir = mkdtempSync(join(tmpdir(), "openlock-report-out-"));
    extractDir = mkdtempSync(join(tmpdir(), "openlock-report-extract-"));

    const sessionDir = join(stateDir, "sessions", "abc123");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({
        id: "abc123",
        name: "demo",
        token: "sk-ant-api03-PLANT_TOKEN_1234567890",
      }),
    );

    writeFileSync(
      join(stateDir, "gateway.log"),
      "ok\nleak Authorization: Bearer planted-bearer-12345678901234\nbye\n",
    );
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
  });

  it("produces a tarball containing redacted summary.json + gateway.log", async () => {
    const { path: tarballPath, doctorFailures } = await report({ stateDir, outDir });
    expect(tarballPath.startsWith(outDir)).toBe(true);
    expect(typeof doctorFailures).toBe("number");

    const extract = Bun.spawn(["tar", "-xzf", tarballPath, "-C", extractDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await extract.exited).toBe(0);

    const baseName = tarballPath
      .substring(tarballPath.lastIndexOf("/") + 1)
      .replace(/\.tar\.gz$/, "");
    const bundleRoot = join(extractDir, baseName);

    const summary = JSON.parse(readFileSync(join(bundleRoot, "summary.json"), "utf8"));
    expect(summary.schemaVersion).toBe(1);
    expect(typeof summary.versions.openlock).toBe("string");
    expect(summary.versions.openshellForkPin).toBe(OPENSHELL_FORK_TAG);
    expect(Array.isArray(summary.doctor)).toBe(true);
    expect(summary.sessions[0].metadata.token).toBe("[REDACTED]");
    expect(summary.log.exists).toBe(true);
    expect(summary.log.linesIncluded).toBe(3);

    const log = readFileSync(join(bundleRoot, "gateway.log"), "utf8");
    expect(log).not.toContain("planted-bearer");
    expect(log).toContain("[REDACTED:");
  });

  it("captures ~/.config/openlock/config.yaml contents in the bundle when present", async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const xdgDir = mkdtempSync(join(tmpdir(), "openlock-report-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = xdgDir;
      const cfgDir = join(xdgDir, "openlock");
      mkdirSync(cfgDir, { recursive: true });
      const cfgBody = "default_harness: opencode\n";
      writeFileSync(join(cfgDir, "config.yaml"), cfgBody);

      const { path: tarballPath } = await report({ stateDir, outDir });
      const extract = Bun.spawn(["tar", "-xzf", tarballPath, "-C", extractDir]);
      expect(await extract.exited).toBe(0);

      const baseName = tarballPath
        .substring(tarballPath.lastIndexOf("/") + 1)
        .replace(/\.tar\.gz$/, "");
      const bundleRoot = join(extractDir, baseName);

      const captured = readFileSync(join(bundleRoot, "global-config.yaml"), "utf8");
      expect(captured).toBe(cfgBody);

      const summary = JSON.parse(readFileSync(join(bundleRoot, "summary.json"), "utf8"));
      expect(summary.globalConfig.exists).toBe(true);
      expect(summary.globalConfig.path).toBe(join(cfgDir, "config.yaml"));
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      rmSync(xdgDir, { recursive: true, force: true });
    }
  });

  it("omits global-config.yaml from the bundle when the file is absent", async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const xdgDir = mkdtempSync(join(tmpdir(), "openlock-report-xdg-"));
    try {
      process.env.XDG_CONFIG_HOME = xdgDir;
      const { path: tarballPath } = await report({ stateDir, outDir });
      const extract = Bun.spawn(["tar", "-xzf", tarballPath, "-C", extractDir]);
      expect(await extract.exited).toBe(0);

      const baseName = tarballPath
        .substring(tarballPath.lastIndexOf("/") + 1)
        .replace(/\.tar\.gz$/, "");
      const bundleRoot = join(extractDir, baseName);

      expect(existsSync(join(bundleRoot, "global-config.yaml"))).toBe(false);

      const summary = JSON.parse(readFileSync(join(bundleRoot, "summary.json"), "utf8"));
      expect(summary.globalConfig.exists).toBe(false);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      rmSync(xdgDir, { recursive: true, force: true });
    }
  });

  it("emits log.exists=false and omits gateway.log when no log file is present", async () => {
    rmSync(join(stateDir, "gateway.log"));
    const { path: tarballPath } = await report({ stateDir, outDir });
    const extract = Bun.spawn(["tar", "-xzf", tarballPath, "-C", extractDir]);
    expect(await extract.exited).toBe(0);

    const baseName = tarballPath
      .substring(tarballPath.lastIndexOf("/") + 1)
      .replace(/\.tar\.gz$/, "");
    const bundleRoot = join(extractDir, baseName);

    const summary = JSON.parse(readFileSync(join(bundleRoot, "summary.json"), "utf8"));
    expect(summary.log.exists).toBe(false);

    const probe = Bun.spawn(["test", "-f", join(bundleRoot, "gateway.log")]);
    expect(await probe.exited).not.toBe(0);
  });
});
