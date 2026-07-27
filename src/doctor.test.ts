import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  buildCmakeCheck,
  buildGatewayReachabilityCheck,
  buildReachabilityProbeArgv,
  buildRuntimeChecks,
  buildSubuidCheck,
  classifyReachabilityProbeExit,
  evaluateGatewayReachability,
  installHint,
  renderDoctorResults,
  runDoctorChecks,
} from "./doctor";
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

  it("is package-manager-neutral on Linux (no distro assumption)", () => {
    const hint = installHint("podman", "linux");
    expect(hint).toContain("podman");
    expect(hint).toContain("package manager");
    expect(hint).not.toContain("apt install");
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

describe("buildCmakeCheck (dev-mode-only, openlock-e7q)", () => {
  it("is absent outside dev mode regardless of whether cmake is installed", () => {
    expect(buildCmakeCheck(false, true)).toEqual([]);
    expect(buildCmakeCheck(false, false)).toEqual([]);
  });

  it("is present and passes in dev mode when cmake is installed", async () => {
    const checks = buildCmakeCheck(true, true);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("cmake");
    expect(await checks[0]?.test()).toBe(true);
  });

  it("is present and fails with an actionable, package-manager-neutral fix when cmake is missing", async () => {
    const checks = buildCmakeCheck(true, false);
    expect(checks).toHaveLength(1);
    expect(await checks[0]?.test()).toBe(false);
    expect(checks[0]?.fix).toContain("cmake");
    expect(checks[0]?.fix).not.toContain("apt install");
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
  // The doctor check resolves the *real* current user via os.userInfo(), so the
  // injected subuid content must be keyed to that user (matches preflight.test).
  const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || "";
  const GOOD_SUBUID = `${CURRENT_USER}:100000:65536\n`; // 65536 > 60000 → pass
  const BAD_SUBUID = `${CURRENT_USER}:100000:50000\n`; // 50000 < 60000 → fail

  it(
    "passes when the subuid count exceeds SANDBOX_UID on Linux podman",
    async () => {
      // Simulate Linux rootless podman: runtime=podman, readSubuid returns valid content.
      // We patch process.platform via the isMac path by running on actual platform;
      // to keep the test platform-agnostic we call runDoctorChecks and look only for
      // the check being present+passing on Linux, or absent on Mac (checked separately).
      if (process.platform === "darwin") return; // subuid check is skipped on Mac — covered below
      if (process.getuid?.() === 0) return; // skipped as root (rootful podman) — covered by unit tests
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
      if (process.getuid?.() === 0) return; // skipped as root (rootful podman) — covered by unit tests
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

  // Deterministic unit coverage of buildSubuidCheck (no dependency on the test runner's uid).
  it("buildSubuidCheck skips when running as root (rootful podman uses no subuid map)", () => {
    expect(buildSubuidCheck(true, false, () => BAD_SUBUID, true)).toEqual([]);
  });

  it("buildSubuidCheck emits the check when non-root (failing outcome covered above)", () => {
    const checks = buildSubuidCheck(true, false, () => BAD_SUBUID, false);
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("rootless podman subuid range");
  });
});

describe("classifyReachabilityProbeExit", () => {
  it("classifies exit 0 as reachable", () => {
    expect(classifyReachabilityProbeExit(0)).toBe("reachable");
  });
  it("classifies exit 1 as unreachable", () => {
    expect(classifyReachabilityProbeExit(1)).toBe("unreachable");
  });
  it("classifies podman-level failure codes (125/126/127) as inconclusive", () => {
    expect(classifyReachabilityProbeExit(125)).toBe("inconclusive");
    expect(classifyReachabilityProbeExit(126)).toBe("inconclusive");
    expect(classifyReachabilityProbeExit(127)).toBe("inconclusive");
  });
  it("classifies our own timeout-kill sentinel (124) as inconclusive", () => {
    expect(classifyReachabilityProbeExit(124)).toBe("inconclusive");
  });
});

describe("buildReachabilityProbeArgv", () => {
  it("emits a `podman run --rm --network openshell --pull missing ...` probe on the given port", () => {
    const argv = buildReachabilityProbeArgv(18081);
    expect(argv).toEqual([
      "podman",
      "run",
      "--rm",
      "--network",
      "openshell",
      "--pull",
      "missing",
      "docker.io/library/busybox:latest",
      "sh",
      "-c",
      "nc -z -w 2 host.containers.internal 18081",
    ]);
  });
});

describe("buildGatewayReachabilityCheck (GH #75 / bd openlock-7er piece 1)", () => {
  const okProbe = async () => ({ ok: true });

  it("is absent when podman is not the runtime (docker no-ops cleanly)", () => {
    expect(buildGatewayReachabilityCheck(false, true, 18081, false, okProbe)).toEqual([]);
  });

  it("is absent when no gateway is running (nothing to test, and keeps CI/test runs spawn-free)", () => {
    expect(buildGatewayReachabilityCheck(true, false, 18081, false, okProbe)).toEqual([]);
  });

  it("is present when podman is the runtime and a gateway is running", () => {
    const checks = buildGatewayReachabilityCheck(true, true, 18081, false, okProbe);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toContain("openshell network");
  });

  it("threads the port and autoReload flag through to the injected probe", async () => {
    let seen: [number, boolean] | undefined;
    const spyProbe = async (port: number, autoReload: boolean) => {
      seen = [port, autoReload];
      return { ok: true };
    };
    const checks = buildGatewayReachabilityCheck(true, true, 18081, true, spyProbe);
    await checks[0]?.test();
    expect(seen).toEqual([18081, true]);
  });
});

describe("evaluateGatewayReachability (pure decision tree, GH #75 piece 1)", () => {
  const PORT = 18081;

  function io(overrides: { networkExists?: boolean; probeExits?: number[]; reloadOk?: boolean }): {
    networkExists: () => Promise<boolean>;
    runProbe: () => Promise<number>;
    runReload: () => Promise<boolean>;
  } {
    const exits = [...(overrides.probeExits ?? [0])];
    return {
      networkExists: async () => overrides.networkExists ?? true,
      runProbe: async () => exits.shift() ?? 0,
      runReload: async () => overrides.reloadOk ?? true,
    };
  }

  it("passes (ok, no detail) when the openshell network doesn't exist yet", async () => {
    const out = await evaluateGatewayReachability(PORT, false, io({ networkExists: false }));
    expect(out.ok).toBe(true);
    expect(out.detail).toContain("not found yet");
    expect(out.fix).toBeUndefined();
  });

  it("passes cleanly when the gateway is reachable", async () => {
    const out = await evaluateGatewayReachability(PORT, false, io({ probeExits: [0] }));
    expect(out).toEqual({ ok: true });
  });

  it("passes with a note when the probe is inconclusive (doesn't misdiagnose it as unreachable)", async () => {
    const out = await evaluateGatewayReachability(PORT, false, io({ probeExits: [125] }));
    expect(out.ok).toBe(true);
    expect(out.detail).toContain("inconclusive");
  });

  it("DEFAULT (suggest-only): fails with the `podman network reload --all` fix, does not auto-run it", async () => {
    let reloadCalled = false;
    const deps = io({ probeExits: [1] });
    const out = await evaluateGatewayReachability(PORT, false, {
      ...deps,
      runReload: async () => {
        reloadCalled = true;
        return true;
      },
    });
    expect(out.ok).toBe(false);
    expect(out.fix).toBe("podman network reload --all");
    expect(out.detail).toContain("GH #75");
    expect(reloadCalled).toBe(false);
  });

  it("auto-reload ENABLED: unreachable -> reload runs -> recovers -> passes with a note", async () => {
    const out = await evaluateGatewayReachability(
      PORT,
      true,
      io({ probeExits: [1, 0], reloadOk: true }),
    );
    expect(out.ok).toBe(true);
    expect(out.detail).toContain("auto-ran");
    expect(out.detail).toContain("network_auto_reload");
  });

  it("auto-reload ENABLED: unreachable -> reload runs -> still unreachable -> fails", async () => {
    const out = await evaluateGatewayReachability(
      PORT,
      true,
      io({ probeExits: [1, 1], reloadOk: true }),
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("still unreachable");
    expect(out.fix).toContain("manually");
  });

  it("auto-reload ENABLED: unreachable -> the reload command itself fails -> fails", async () => {
    const out = await evaluateGatewayReachability(
      PORT,
      true,
      io({ probeExits: [1], reloadOk: false }),
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("itself failed");
  });
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
