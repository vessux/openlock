import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctorChecks } from "./doctor";

// Each check spawns real subprocesses (which/podman/curl). On a cold CI
// runner `podman info` alone can take a few seconds; the bun-test default
// 5s budget is too tight. 30s is conservative.
const TIMEOUT_MS = 30_000;

describe("runDoctorChecks", () => {
  it(
    "returns one result per check with name + ok flag",
    async () => {
      const results = await runDoctorChecks();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(typeof r.name).toBe("string");
        expect(typeof r.ok).toBe("boolean");
      }
    },
    TIMEOUT_MS,
  );

  it(
    "includes a git check",
    async () => {
      const results = await runDoctorChecks();
      expect(results.some((r) => r.name === "git")).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "includes a podman check",
    async () => {
      const results = await runDoctorChecks();
      expect(results.some((r) => r.name === "podman")).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "includes a credentials check",
    async () => {
      const results = await runDoctorChecks();
      expect(results.some((r) => r.name.includes("credentials"))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe("doctor global config check", () => {
  const oldEnv = { ...process.env };
  let tmp = "";

  beforeEach(() => {
    process.env = { ...oldEnv };
    tmp = mkdtempSync(join(tmpdir(), "openlock-doctor-globalcfg-"));
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    process.env = oldEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "passes when ~/.config/openlock/config.yaml is absent",
    async () => {
      const results = await runDoctorChecks();
      const r = results.find((x) => x.name.includes("global config"));
      expect(r).toBeDefined();
      expect(r?.ok).toBe(true);
      expect(r?.detail).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  it(
    "passes when ~/.config/openlock/config.yaml is valid",
    async () => {
      const dir = join(tmp, "openlock");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.yaml"), "default_harness: opencode\n");
      const results = await runDoctorChecks();
      const r = results.find((x) => x.name.includes("global config"));
      expect(r).toBeDefined();
      expect(r?.ok).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "fails with detail when ~/.config/openlock/config.yaml has invalid content",
    async () => {
      const dir = join(tmp, "openlock");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.yaml"), "default_harness: bogus\n");
      const results = await runDoctorChecks();
      const r = results.find((x) => x.name.includes("global config"));
      expect(r).toBeDefined();
      expect(r?.ok).toBe(false);
      expect(r?.detail).toBeDefined();
      expect(r?.detail).toMatch(/default_harness/);
    },
    TIMEOUT_MS,
  );
});
