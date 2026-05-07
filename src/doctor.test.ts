import { describe, it, expect } from "bun:test";
import { runDoctorChecks } from "./doctor";

describe("runDoctorChecks", () => {
  it("returns one result per check with name + ok flag", async () => {
    const results = await runDoctorChecks();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.ok).toBe("boolean");
    }
  });

  it("includes a git check", async () => {
    const results = await runDoctorChecks();
    expect(results.some((r) => r.name === "git")).toBe(true);
  });

  it("includes a podman check", async () => {
    const results = await runDoctorChecks();
    expect(results.some((r) => r.name === "podman")).toBe(true);
  });

  it("includes a credentials check", async () => {
    const results = await runDoctorChecks();
    expect(results.some((r) => r.name.includes("credentials"))).toBe(true);
  });
});
