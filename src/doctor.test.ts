import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  asAmbiguousWarning,
  BASE_IMAGE_DRIFT_CHECK_NAME,
  buildBaseImageDriftCheck,
  buildCmakeCheck,
  buildGatewayPortRecordCheck,
  buildGatewayReachabilityCheck,
  buildReachabilityProbeArgv,
  buildRuntimeChecks,
  buildSubuidCheck,
  classifyReachabilityProbeExit,
  evaluateGatewayReachability,
  GATEWAY_PORT_RECORD_CHECK_NAME,
  installHint,
  renderDoctorResults,
  runDoctorChecks,
} from "./doctor";
import { globalConfigPath } from "./global-config/paths";
import { computeBaseTag, GHCR_BASE_PREFIX } from "./sandbox/ensure-base";
import { resolveGatewayPort } from "./sandbox/ensure-gateway";
import { BASE_CONTAINERFILE } from "./sandbox/image-build";

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
    // openlock-ucm: the check's own label names a path ("global config
    // (<path>)"), which reads as "present and valid" when green. Absent must
    // still PASS (it's the default, fresh-install state, not an error) but
    // now says so explicitly in the detail line rather than rendering
    // identically to a present-and-valid file.
    "passes AND reports 'not present' when ~/.config/openlock/config.yaml is absent",
    async () => {
      const results = await runDoctorChecks("podman");
      const r = results.find((x) => x.name.includes("global config"));
      expect(r).toBeDefined();
      expect(r?.ok).toBe(true);
      expect(r?.detail).toBeDefined();
      expect(r?.detail).toMatch(/not present/);
    },
    TIMEOUT_MS,
  );

  it(
    "passes with no 'not present' detail when ~/.config/openlock/config.yaml is valid",
    async () => {
      const dir = join(tmp, "openlock");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.yaml"), "default_harness: opencode\n");
      const results = await runDoctorChecks("podman");
      const r = results.find((x) => x.name.includes("global config"));
      expect(r).toBeDefined();
      expect(r?.ok).toBe(true);
      expect(r?.detail).toBeUndefined();
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

describe("buildBaseImageDriftCheck (openlock-x83q)", () => {
  it("is absent when .openlock/Containerfile can't be read (not a project directory)", () => {
    const checks = buildBaseImageDriftCheck("/nonexistent", () => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(checks).toEqual([]);
  });

  it("passes with no detail when the pinned hash matches the CLI's embedded base content", async () => {
    const hash = computeBaseTag(BASE_CONTAINERFILE).slice(GHCR_BASE_PREFIX.length);
    const checks = buildBaseImageDriftCheck("/proj", () => `FROM ${GHCR_BASE_PREFIX}${hash}\n`);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe(BASE_IMAGE_DRIFT_CHECK_NAME);
    expect(await checks[0]?.test()).toEqual({ ok: true });
  });

  it("fails with a fix naming update-base + rebuild when the pinned hash is stale", async () => {
    const staleHash = "aaaaaaaaaaaa";
    const checks = buildBaseImageDriftCheck(
      "/proj",
      () => `FROM ${GHCR_BASE_PREFIX}${staleHash}\n`,
    );
    expect(checks).toHaveLength(1);
    const outcome = await checks[0]?.test();
    expect(outcome).toMatchObject({ ok: false });
    if (typeof outcome === "boolean" || outcome === undefined) throw new Error("unreachable");
    expect(outcome.detail).toContain(staleHash);
    expect(outcome.fix).toContain("openlock update-base --project /proj");
    expect(outcome.fix).toContain("--rebuild");
  });

  it("passes with an explicit detail (not silently absent) when the FROM line is a custom base", async () => {
    const checks = buildBaseImageDriftCheck("/proj", () => "FROM ubuntu:24.04\n");
    expect(checks).toHaveLength(1);
    const outcome = await checks[0]?.test();
    expect(outcome).toMatchObject({ ok: true });
    if (typeof outcome === "boolean" || outcome === undefined) throw new Error("unreachable");
    expect(outcome.detail).toMatch(/custom base image/);
  });

  it("passes with an explicit detail (not silently absent) when no active FROM line is found", async () => {
    const checks = buildBaseImageDriftCheck("/proj", () => "# FROM ubuntu\nRUN echo hi\n");
    expect(checks).toHaveLength(1);
    const outcome = await checks[0]?.test();
    expect(outcome).toMatchObject({ ok: true });
    if (typeof outcome === "boolean" || outcome === undefined) throw new Error("unreachable");
    expect(outcome.detail).toMatch(/no active FROM|skipping/);
  });
});

describe("runDoctorChecks base image drift wiring", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "openlock-doctor-basedrift-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "is absent when projectDir has no .openlock/Containerfile",
    async () => {
      const results = await runDoctorChecks("podman", undefined, tmp);
      expect(results.some((r) => r.name === BASE_IMAGE_DRIFT_CHECK_NAME)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "fails when the project's pinned base hash is stale, naming the projectDir in the fix",
    async () => {
      const openlockDir = join(tmp, ".openlock");
      mkdirSync(openlockDir, { recursive: true });
      writeFileSync(join(openlockDir, "Containerfile"), `FROM ${GHCR_BASE_PREFIX}aaaaaaaaaaaa\n`);
      const results = await runDoctorChecks("podman", undefined, tmp);
      const r = results.find((x) => x.name === BASE_IMAGE_DRIFT_CHECK_NAME);
      expect(r).toBeDefined();
      expect(r?.ok).toBe(false);
      expect(r?.fix).toContain(`openlock update-base --project ${tmp}`);
    },
    TIMEOUT_MS,
  );
});

describe("runDoctorChecks gateway port record wiring (openlock-x8m8)", () => {
  // OPENLOCK_STATE_DIR points every call at a SCRATCH dir for the duration
  // of each test, save/restored — never the real state dir, never a real
  // gateway process (see feedback_no_optional_live_state_deps.md). "running"
  // is faked by writing this TEST PROCESS's own pid to gateway.pid — a real,
  // genuinely-alive pid, just not an actual gateway.
  const oldOverride = process.env.OPENLOCK_STATE_DIR;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openlock-doctor-gwport-"));
    process.env.OPENLOCK_STATE_DIR = dir;
  });

  afterEach(() => {
    if (oldOverride === undefined) delete process.env.OPENLOCK_STATE_DIR;
    else process.env.OPENLOCK_STATE_DIR = oldOverride;
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "is absent when no gateway is running (no pid file at all)",
    async () => {
      const results = await runDoctorChecks("podman");
      expect(results.some((r) => r.name === GATEWAY_PORT_RECORD_CHECK_NAME)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "is absent when the persisted record matches what this (relocated) state dir currently derives",
    async () => {
      writeFileSync(join(dir, "gateway.pid"), String(process.pid));
      writeFileSync(join(dir, "gateway.port"), String(resolveGatewayPort(dir)));
      const results = await runDoctorChecks("podman");
      expect(results.some((r) => r.name === GATEWAY_PORT_RECORD_CHECK_NAME)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "fails, naming the stale record, when the persisted record disagrees with the derived port",
    async () => {
      writeFileSync(join(dir, "gateway.pid"), String(process.pid));
      writeFileSync(join(dir, "gateway.port"), "18500");
      const results = await runDoctorChecks("podman");
      const r = results.find((x) => x.name === GATEWAY_PORT_RECORD_CHECK_NAME);
      expect(r).toBeDefined();
      expect(r?.ok).toBe(false);
      expect(r?.detail).toContain("18500");
      expect(r?.detail).toContain(String(resolveGatewayPort(dir)));
    },
    TIMEOUT_MS,
  );
});

describe("buildRuntimeChecks", () => {
  // openlock-ucm regression coverage: readiness (machine/socket/daemon) must
  // gate on the RESOLVED runtime only. Both being installed used to add a
  // readiness check for BOTH — so a healthy podman-only Mac with the Docker
  // CLI merely present (no daemon) failed doctor on "docker daemon reachable"
  // even though docker was never going to be used.
  it("gates readiness on the resolved runtime (podman) when both are installed", () => {
    const checks = buildRuntimeChecks({ podman: true, docker: true }, false, "podman");
    expect(checks.map((c) => c.name)).toEqual(["podman", "podman API socket active", "docker"]);
  });

  it("the non-resolved installed runtime is reported informational (never a failure)", async () => {
    const checks = buildRuntimeChecks({ podman: true, docker: true }, false, "podman");
    const dockerCheck = checks.find((c) => c.name === "docker");
    const outcome = await dockerCheck?.test();
    expect(outcome).not.toBe(false);
    expect(outcome).toMatchObject({ ok: true });
    expect((outcome as { detail?: string }).detail).toContain("not in use");
    expect((outcome as { detail?: string }).detail).toContain("podman");
  });

  it("gates readiness on the resolved runtime (docker) when both are installed", () => {
    const checks = buildRuntimeChecks({ podman: true, docker: true }, false, "docker");
    expect(checks.map((c) => c.name)).toEqual(["podman", "docker", "docker daemon reachable"]);
  });

  // Operator follow-up to the ucm fix: a fresh install with BOTH runtimes
  // present and neither resolvable used to skip readiness on both, which is
  // itself a false PASS — a stopped podman machine on such a box got an
  // all-green `doctor` and then `openlock sandbox` failed anyway. The fix:
  // probe readiness for every installed runtime in this case too, but the
  // probe outcome must NEVER be allowed to fail doctor's exit code (that
  // would re-open ucm) — see asAmbiguousWarning below for the mechanism.
  it("in the ambiguous case (both installed, neither resolves), readiness IS probed for BOTH", () => {
    const checks = buildRuntimeChecks({ podman: true, docker: true }, false, null);
    expect(checks.map((c) => c.name)).toEqual([
      "podman",
      "podman API socket active",
      "docker",
      "docker daemon reachable",
    ]);
  });

  it(
    "in the ambiguous case, every check's ok bit is true regardless of this machine's real " +
      "runtime state — a real failure here would re-open openlock-ucm",
    async () => {
      const checks = buildRuntimeChecks({ podman: true, docker: true }, false, null);
      for (const c of checks) {
        const outcome = await c.test();
        expect(typeof outcome === "boolean" ? outcome : outcome.ok).toBe(true);
      }
    },
  );

  it("reports only the installed runtime", () => {
    const names = buildRuntimeChecks({ podman: false, docker: true }, false, "docker").map(
      (c) => c.name,
    );
    expect(names).toEqual(["docker", "docker daemon reachable"]);
  });

  it("emits a single install-a-runtime failure when neither is installed", () => {
    const checks = buildRuntimeChecks({ podman: false, docker: false }, false, null);
    expect(checks.map((c) => c.name)).toEqual(["container runtime (podman/docker)"]);
    expect(checks[0]?.fix).toContain("podman");
  });

  it("uses the podman machine check on macOS instead of the API socket", () => {
    const names = buildRuntimeChecks({ podman: true, docker: false }, true, "podman").map(
      (c) => c.name,
    );
    expect(names).toEqual(["podman", "podman machine (running)"]);
  });
});

describe("asAmbiguousWarning (openlock-ucm ambiguous-case follow-up)", () => {
  // Synthetic checks decoupled from real podman/docker state, so these are
  // deterministic on any machine regardless of what's actually installed or
  // running — the property under test is the wrapper's own ok-forcing logic,
  // not any real runtime probe.
  const failingBoolCheck = { name: "docker daemon reachable", test: async () => false };
  const failingOutcomeCheck = {
    name: "docker daemon reachable",
    test: async () => ({ ok: false, detail: "connection refused", fix: "start Docker" }),
    fix: "start Docker Desktop",
  };
  const passingBoolCheck = { name: "docker daemon reachable", test: async () => true };
  const passingOutcomeCheck = {
    name: "docker daemon reachable",
    test: async () => ({ ok: true }),
  };

  it("THE CONTRACT: a failing boolean check's wrapped ok bit is true (never fails doctor's exit code)", async () => {
    const wrapped = asAmbiguousWarning("docker", failingBoolCheck);
    const outcome = await wrapped.test();
    expect(typeof outcome === "boolean" ? outcome : outcome.ok).toBe(true);
  });

  it("THE CONTRACT: a failing CheckOutcome's wrapped ok bit is true (never fails doctor's exit code)", async () => {
    const wrapped = asAmbiguousWarning("docker", failingOutcomeCheck);
    const outcome = await wrapped.test();
    expect(typeof outcome === "boolean" ? outcome : outcome.ok).toBe(true);
  });

  it("renderDoctorResults counts zero failures for a wrapped-failing check (the actual exit-code path)", async () => {
    // This is the property that matters end-to-end: doctor() calls
    // process.exit(1) iff renderDoctorResults reports failures > 0. Feed its
    // real input shape (a DoctorResult array) rather than asserting on the
    // Check's raw outcome, so this test breaks if that wiring ever changes.
    const wrapped = asAmbiguousWarning("docker", failingOutcomeCheck);
    const outcome = await wrapped.test();
    const result = {
      name: wrapped.name,
      ok: typeof outcome === "boolean" ? outcome : outcome.ok,
      detail: typeof outcome === "boolean" ? undefined : outcome.detail,
    };
    const { failures } = renderDoctorResults([result]);
    expect(failures).toBe(0);
  });

  it("a failing outcome's detail is unmistakably a warning and stays actionable", async () => {
    const wrapped = asAmbiguousWarning("docker", failingOutcomeCheck);
    const outcome = await wrapped.test();
    const detail = typeof outcome === "boolean" ? undefined : outcome.detail;
    expect(detail).toContain("WARNING");
    expect(detail).toContain("connection refused"); // original detail preserved
    expect(detail).toContain("start Docker"); // original fix preserved (renderDoctorResults hides `fix:` on ok:true)
    expect(detail).toContain("OPENLOCK_RUNTIME=docker"); // actionable: names the concrete env var + value
  });

  it("a passing boolean check passes through untouched (no warning noise on a healthy probe)", async () => {
    const wrapped = asAmbiguousWarning("docker", passingBoolCheck);
    expect(await wrapped.test()).toEqual({ ok: true });
  });

  it("a passing CheckOutcome passes through untouched", async () => {
    const wrapped = asAmbiguousWarning("docker", passingOutcomeCheck);
    expect(await wrapped.test()).toEqual({ ok: true });
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

  // openlock-ucm end-to-end regression: `openlock doctor` (i.e. runDoctorChecks
  // called with NO explicit runtime, the standalone-CLI path) must resolve a
  // runtime itself via resolveRuntimeNonInteractive (env > config > single-
  // binary autodetect) and gate readiness on ONLY that one, exactly like the
  // explicit-runtime path session preflight already got right. This dev box
  // has both podman and docker binaries on PATH, so it exercises the real
  // "both present" case the bug report was filed against — OPENLOCK_RUNTIME
  // pins the resolution deterministically without needing either daemon to
  // actually be reachable.
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env = oldEnv;
  });

  it(
    "gates readiness on OPENLOCK_RUNTIME=podman even when the docker CLI is also present",
    async () => {
      process.env = { ...oldEnv, OPENLOCK_RUNTIME: "podman" };
      const results = await runDoctorChecks(undefined);
      const docker = results.find((r) => r.name === "docker");
      // The docker CLI being present must still show up (informational)...
      expect(docker).toBeDefined();
      expect(docker?.ok).toBe(true);
      expect(docker?.detail).toContain("not in use");
      // ...but its readiness (daemon reachability) must never be checked, so
      // a dead/absent docker daemon can't fail doctor on a podman machine.
      const dockerReadiness = results.find((r) => r.name === "docker daemon reachable");
      expect(dockerReadiness).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  it(
    "gates readiness on OPENLOCK_RUNTIME=docker even when the podman CLI is also present",
    async () => {
      process.env = { ...oldEnv, OPENLOCK_RUNTIME: "docker" };
      const results = await runDoctorChecks(undefined);
      const podman = results.find((r) => r.name === "podman");
      expect(podman).toBeDefined();
      expect(podman?.ok).toBe(true);
      expect(podman?.detail).toContain("not in use");
      const podmanReadiness = results.find(
        (r) => r.name === "podman API socket active" || r.name === "podman machine (running)",
      );
      expect(podmanReadiness).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  // Operator follow-up, full end-to-end: a genuinely fresh install (no
  // OPENLOCK_RUNTIME, no config.yaml at all) with both binaries on PATH must
  // NOT get a silent all-green pass on readiness — it must probe both, and
  // whatever it finds must still leave doctor's exit code at 0. This dev box
  // has a real ~/.config/openlock/config.yaml with default_runtime set, so
  // XDG_CONFIG_HOME is redirected to an empty temp dir to reproduce a truly
  // unconfigured machine rather than relying on this box's actual state.
  let ambiguousTmp = "";
  beforeEach(() => {
    ambiguousTmp = mkdtempSync(join(tmpdir(), "openlock-doctor-ambiguous-"));
  });
  afterEach(() => {
    rmSync(ambiguousTmp, { recursive: true, force: true });
  });

  it(
    "a fresh install (no env, no config) with both runtimes installed probes BOTH and stays exit-0-safe",
    async () => {
      process.env = { ...oldEnv, XDG_CONFIG_HOME: ambiguousTmp };
      delete process.env.OPENLOCK_RUNTIME;
      const results = await runDoctorChecks(undefined);
      const runtimeRelevant = results.filter((r) =>
        [
          "podman",
          "podman API socket active",
          "podman machine (running)",
          "docker",
          "docker daemon reachable",
        ].includes(r.name),
      );
      // Both runtimes' readiness checks are actually present (not skipped) —
      // this is exactly what silently regresses to a false pass if the
      // ambiguous branch stops probing.
      expect(runtimeRelevant.some((r) => r.name === "podman")).toBe(true);
      expect(runtimeRelevant.some((r) => r.name === "docker")).toBe(true);
      const hasPodmanReadiness = runtimeRelevant.some(
        (r) => r.name === "podman API socket active" || r.name === "podman machine (running)",
      );
      const hasDockerReadiness = runtimeRelevant.some((r) => r.name === "docker daemon reachable");
      expect(hasPodmanReadiness).toBe(true);
      expect(hasDockerReadiness).toBe(true);
      // THE CONTRACT: no matter what those probes actually found on this
      // machine, none of the runtime-relevant results may be a failure — and
      // feeding them through the real renderDoctorResults (what doctor()
      // bases process.exit(1) on) must report zero failures among them.
      for (const r of runtimeRelevant) expect(r.ok).toBe(true);
      const { failures } = renderDoctorResults(runtimeRelevant);
      expect(failures).toBe(0);
    },
    TIMEOUT_MS,
  );
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

describe("buildGatewayPortRecordCheck (openlock-x8m8)", () => {
  it("is absent when the gateway is not running (nothing live to be wrong about)", () => {
    const checks = buildGatewayPortRecordCheck(false, "/proj", 18081, () => 19999);
    expect(checks).toEqual([]);
  });

  it("is absent when there's no persisted record yet", () => {
    const checks = buildGatewayPortRecordCheck(true, "/proj", 18081, () => undefined);
    expect(checks).toEqual([]);
  });

  it("is absent when the record matches the derived port", () => {
    const checks = buildGatewayPortRecordCheck(true, "/proj", 18081, () => 18081);
    expect(checks).toEqual([]);
  });

  it("fails naming both the stale recorded port and the currently-derived one when they disagree", async () => {
    const checks = buildGatewayPortRecordCheck(true, "/proj", 18081, () => 18500);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe(GATEWAY_PORT_RECORD_CHECK_NAME);
    const outcome = await checks[0]?.test();
    expect(outcome).toMatchObject({ ok: false });
    if (typeof outcome === "boolean" || outcome === undefined) throw new Error("unreachable");
    expect(outcome.detail).toContain("18500");
    expect(outcome.detail).toContain("18081");
    expect(outcome.fix).toContain("openlock gateway stop");
    expect(outcome.fix).toContain("openlock gateway start");
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
