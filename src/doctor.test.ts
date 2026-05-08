import { describe, expect, it } from "bun:test";
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
