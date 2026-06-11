import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeChecks, installHint, renderDoctorResults, runDoctorChecks } from "./doctor";
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

describe("buildRuntimeChecks", () => {
  it("reports BOTH runtimes (presence + readiness) when both are installed", () => {
    const names = buildRuntimeChecks({ podman: true, docker: true }, false).map((c) => c.name);
    expect(names).toEqual([
      "podman",
      "podman API socket active",
      "docker",
      "docker daemon reachable",
    ]);
  });

  it("reports only the installed runtime", () => {
    const names = buildRuntimeChecks({ podman: false, docker: true }, false).map((c) => c.name);
    expect(names).toEqual(["docker", "docker daemon reachable"]);
  });

  it("emits a single install-a-runtime failure when neither is installed", () => {
    const checks = buildRuntimeChecks({ podman: false, docker: false }, false);
    expect(checks.map((c) => c.name)).toEqual(["container runtime (podman/docker)"]);
    expect(checks[0]?.fix).toContain("podman");
  });

  it("uses the podman machine check on macOS instead of the API socket", () => {
    const names = buildRuntimeChecks({ podman: true, docker: false }, true).map((c) => c.name);
    expect(names).toEqual(["podman", "podman machine (running)"]);
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

describe("rootless podman subuid check", () => {
  const GOOD_SUBUID = "testuser:100000:65536\n"; // 65536 > 60000 → pass
  const BAD_SUBUID = "testuser:100000:50000\n"; // 50000 < 60000 → fail

  it(
    "passes when the subuid count exceeds SANDBOX_UID on Linux podman",
    async () => {
      // Simulate Linux rootless podman: runtime=podman, readSubuid returns valid content.
      // We patch process.platform via the isMac path by running on actual platform;
      // to keep the test platform-agnostic we call runDoctorChecks and look only for
      // the check being present+passing on Linux, or absent on Mac (checked separately).
      if (process.platform === "darwin") return; // subuid check is skipped on Mac — covered below
      const results = await runDoctorChecks("podman", () => GOOD_SUBUID);
      const r = results.find((x) => x.name === "rootless podman subuid range");
      expect(r).toBeDefined();
      expect(r?.ok).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "fails with fix hint when the subuid count is too small on Linux podman",
    async () => {
      if (process.platform === "darwin") return; // subuid check is skipped on Mac — covered below
      const results = await runDoctorChecks("podman", () => BAD_SUBUID);
      const r = results.find((x) => x.name === "rootless podman subuid range");
      expect(r).toBeDefined();
      expect(r?.ok).toBe(false);
      expect(r?.fix).toContain("usermod");
      expect(r?.fix).toContain("podman system migrate");
    },
    TIMEOUT_MS,
  );

  it(
    "is absent when runtime is docker (not podman)",
    async () => {
      const results = await runDoctorChecks("docker", () => BAD_SUBUID);
      const r = results.find((x) => x.name === "rootless podman subuid range");
      expect(r).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  it(
    "is absent when runtime is null",
    async () => {
      const results = await runDoctorChecks(null, () => BAD_SUBUID);
      const r = results.find((x) => x.name === "rootless podman subuid range");
      expect(r).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  it(
    "is absent on macOS (podman runs in a VM, not rootless)",
    async () => {
      if (process.platform !== "darwin") return; // only meaningful on Mac
      const results = await runDoctorChecks("podman", () => BAD_SUBUID);
      const r = results.find((x) => x.name === "rootless podman subuid range");
      expect(r).toBeUndefined();
    },
    TIMEOUT_MS,
  );
});

describe("renderDoctorResults", () => {
  it("prints `fix:` only for failed checks that have a fix", () => {
    const { lines, failures } = renderDoctorResults([
      { name: "git", ok: true, fix: "brew install git" },
      { name: "credentials", ok: false, fix: "openlock login" },
      { name: "global config", ok: false, detail: "parse error" },
    ]);
    const out = lines.join("\n");
    expect(failures).toBe(2);
    // passing check carries a static fix, but it must NOT be printed
    expect(out).not.toContain("fix: brew install git");
    // failing check with a fix → printed
    expect(out).toContain("fix: openlock login");
    // failing check without a fix → detail shown, no stray fix line
    expect(out).toContain("parse error");
    expect(out).not.toContain("fix: undefined");
  });
});
