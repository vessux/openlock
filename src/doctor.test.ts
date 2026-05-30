import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHint, runDoctorChecks } from "./doctor";
import { globalConfigPath } from "./global-config/paths";

// Each check spawns real subprocesses (which/podman/curl). On a cold CI
// runner `podman info` alone can take a few seconds; the bun-test default
// 5s budget is too tight. 30s is conservative.
const TIMEOUT_MS = 30_000;

describe("runDoctorChecks", () => {
  it(
    "returns one result per check with name + ok flag",
    async () => {
      const results = await runDoctorChecks("podman");
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
      const results = await runDoctorChecks("podman");
      expect(results.some((r) => r.name === "git")).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "includes a podman check when runtime is podman",
    async () => {
      const results = await runDoctorChecks("podman");
      expect(results.some((r) => r.name === "podman")).toBe(true);
      expect(results.some((r) => r.name === "docker")).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "includes a docker check when runtime is docker",
    async () => {
      const results = await runDoctorChecks("docker");
      expect(results.some((r) => r.name === "docker")).toBe(true);
      expect(results.some((r) => r.name === "docker daemon reachable")).toBe(true);
      expect(results.some((r) => r.name === "podman")).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "includes a credentials check",
    async () => {
      const results = await runDoctorChecks("podman");
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
      const results = await runDoctorChecks("podman");
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
      const results = await runDoctorChecks("podman");
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
      const results = await runDoctorChecks("podman");
      const r = results.find((x) => x.name.includes("global config"));
      expect(r).toBeDefined();
      expect(r?.ok).toBe(false);
      expect(r?.detail).toBeDefined();
      expect(r?.detail).toMatch(/default_harness/);
      const cfg = results.find((x) => x.name.startsWith("global config"));
      expect(cfg?.ok).toBe(false);
      expect(cfg?.fix).toBe(`edit or remove ${globalConfigPath()}`);
    },
    TIMEOUT_MS,
  );
});

describe("installHint", () => {
  it("uses brew on macOS", () => {
    expect(installHint("git", "darwin")).toBe("brew install git");
  });

  it("uses apt on Linux", () => {
    expect(installHint("podman", "linux")).toBe("apt install podman");
  });
});

describe("doctor fix hints", () => {
  const oldEnv = { ...process.env };
  let tmp = "";

  beforeEach(() => {
    process.env = { ...oldEnv };
    tmp = mkdtempSync(join(tmpdir(), "openlock-doctor-fix-"));
    process.env.XDG_CONFIG_HOME = tmp;
  });

  afterEach(() => {
    process.env = oldEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("attaches `openlock login` fix to a failing credentials check", async () => {
    const results = await runDoctorChecks("podman");
    const cred = results.find((r) => r.name.startsWith("credentials"));
    expect(cred?.ok).toBe(false);
    expect(cred?.fix).toBe("openlock login");
  });

  it("attaches the platform install hint to the git check", async () => {
    const results = await runDoctorChecks("podman");
    const git = results.find((r) => r.name === "git");
    expect(git?.fix).toBe(installHint("git"));
  });
});

describe("doctor non-interactive runtime", () => {
  it("emits a failing container-runtime check (no prompt) when no runtime resolves", async () => {
    const results = await runDoctorChecks(null);
    const rt = results.find((r) => r.name.startsWith("container runtime"));
    expect(rt?.ok).toBe(false);
    expect(rt?.fix).toContain("podman");
    const runtimeSpecific = results.some(
      (r) => r.name.includes("machine") || r.name.includes("socket") || r.name.includes("daemon"),
    );
    expect(runtimeSpecific).toBe(false);
  });
});
