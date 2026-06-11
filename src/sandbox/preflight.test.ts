import { describe, expect, it } from "bun:test";
import os from "node:os";
import { type PreflightDeps, preflight } from "./preflight";

const CURRENT_USER = os.userInfo().username || process.env.USER || "";
// Good range: count 65536 > SANDBOX_UID (60000); bad range: count 50000 < SANDBOX_UID.
const GOOD_SUBUID = `${CURRENT_USER}:100000:65536\n`;
const BAD_SUBUID = `${CURRENT_USER}:100000:50000\n`;

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    runDoctorChecks: async () => [
      { name: "git", ok: true },
      { name: "podman", ok: true },
      { name: "podman machine (running)", ok: true },
      { name: "credentials (openlock login)", ok: true },
    ],
    hasCredentials: () => true,
    isMac: true,
    runtime: "podman",
    podmanMachineRunning: async () => true,
    confirmStartMachine: async () => true,
    ensureHostRuntimeReady: async () => true,
    podmanSocketActive: async () => true,
    dockerDaemonReachable: async () => true,
    login: async () => {
      throw new Error("login should not be called when token present");
    },
    ...overrides,
  };
}

describe("preflight", () => {
  it("succeeds when everything passes", async () => {
    const result = await preflight({ tty: true, deps: makeDeps() });
    expect(result.ok).toBe(true);
  });

  it("fails when git is missing", async () => {
    const deps = makeDeps({
      runDoctorChecks: async () => [
        { name: "git", ok: false },
        { name: "podman", ok: true },
        { name: "podman machine (running)", ok: true },
        { name: "credentials (openlock login)", ok: true },
      ],
    });
    const result = await preflight({ tty: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("git");
  });

  it("fails when podman is missing", async () => {
    const deps = makeDeps({
      runDoctorChecks: async () => [
        { name: "git", ok: true },
        { name: "podman", ok: false },
        { name: "podman machine (running)", ok: false },
        { name: "credentials (openlock login)", ok: true },
      ],
    });
    const result = await preflight({ tty: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("podman");
  });

  it("starts the machine on Mac when stopped + tty + user consents", async () => {
    let started = false;
    let calls = 0;
    const deps = makeDeps({
      podmanMachineRunning: async () => {
        calls += 1;
        return calls > 1;
      },
      confirmStartMachine: async () => true,
      ensureHostRuntimeReady: async () => {
        started = true;
        return true;
      },
    });
    const result = await preflight({ tty: true, deps });
    expect(started).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("fails on Mac when machine stopped + non-tty", async () => {
    const deps = makeDeps({
      podmanMachineRunning: async () => false,
    });
    const result = await preflight({ tty: false, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("podman machine start");
  });

  it("fails on Linux when socket inactive", async () => {
    const deps = makeDeps({
      isMac: false,
      podmanSocketActive: async () => false,
    });
    const result = await preflight({ tty: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("systemctl");
  });

  it("runs login() inline when credentials missing + tty", async () => {
    let logged = false;
    let creds = false;
    const deps = makeDeps({
      hasCredentials: () => creds,
      login: async () => {
        logged = true;
        creds = true;
      },
    });
    const result = await preflight({ tty: true, deps });
    expect(logged).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("fails when credentials missing + non-tty", async () => {
    const deps = makeDeps({
      hasCredentials: () => false,
    });
    const result = await preflight({ tty: false, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("openlock login");
  });

  it("uses docker daemon check when runtime is docker", async () => {
    let dockerCalled = false;
    const deps = makeDeps({
      runtime: "docker",
      runDoctorChecks: async () => [
        { name: "git", ok: true },
        { name: "docker", ok: true },
        { name: "docker daemon reachable", ok: true },
        { name: "credentials (openlock login)", ok: true },
      ],
      dockerDaemonReachable: async () => {
        dockerCalled = true;
        return true;
      },
    });
    const result = await preflight({ tty: true, deps });
    expect(dockerCalled).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("fails when docker daemon unreachable on Mac", async () => {
    const deps = makeDeps({
      runtime: "docker",
      isMac: true,
      runDoctorChecks: async () => [
        { name: "git", ok: true },
        { name: "docker", ok: true },
        { name: "docker daemon reachable", ok: false },
        { name: "credentials (openlock login)", ok: true },
      ],
      dockerDaemonReachable: async () => false,
    });
    const result = await preflight({ tty: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason?.toLowerCase()).toContain("docker desktop");
  });

  it("fails when docker daemon unreachable on linux", async () => {
    const deps = makeDeps({
      runtime: "docker",
      isMac: false,
      runDoctorChecks: async () => [
        { name: "git", ok: true },
        { name: "docker", ok: true },
        { name: "docker daemon reachable", ok: false },
        { name: "credentials (openlock login)", ok: true },
      ],
      dockerDaemonReachable: async () => false,
    });
    const result = await preflight({ tty: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("systemctl");
  });

  it("fails when docker is missing", async () => {
    const deps = makeDeps({
      runtime: "docker",
      runDoctorChecks: async () => [
        { name: "git", ok: true },
        { name: "docker", ok: false },
        { name: "docker daemon reachable", ok: false },
        { name: "credentials (openlock login)", ok: true },
      ],
    });
    const result = await preflight({ tty: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("docker is required");
  });

  it("passes on Linux podman when subuid count covers SANDBOX_UID", async () => {
    const deps = makeDeps({
      isMac: false,
      isRoot: false,
      podmanSocketActive: async () => true,
      readSubuid: () => GOOD_SUBUID,
    });
    const result = await preflight({ tty: false, deps });
    expect(result.ok).toBe(true);
  });

  it("fails on Linux podman when subuid count is too small", async () => {
    const deps = makeDeps({
      isMac: false,
      isRoot: false,
      podmanSocketActive: async () => true,
      readSubuid: () => BAD_SUBUID,
    });
    const result = await preflight({ tty: false, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("usermod");
    expect(result.reason).toContain("podman system migrate");
  });

  it("skips subuid check when running as root (rootful podman uses no subuid map)", async () => {
    const deps = makeDeps({
      isMac: false,
      isRoot: true,
      podmanSocketActive: async () => true,
      readSubuid: () => BAD_SUBUID,
    });
    const result = await preflight({ tty: false, deps });
    expect(result.ok).toBe(true);
  });

  it("skips subuid check on macOS podman", async () => {
    // isMac: true — podman runs in a VM, subuid is irrelevant
    const deps = makeDeps({
      isMac: true,
      readSubuid: () => BAD_SUBUID,
    });
    const result = await preflight({ tty: true, deps });
    expect(result.ok).toBe(true);
  });

  it("skips subuid check when runtime is docker", async () => {
    const deps = makeDeps({
      runtime: "docker",
      isMac: false,
      runDoctorChecks: async () => [
        { name: "git", ok: true },
        { name: "docker", ok: true },
        { name: "docker daemon reachable", ok: true },
        { name: "credentials (openlock login)", ok: true },
      ],
      dockerDaemonReachable: async () => true,
      readSubuid: () => BAD_SUBUID,
    });
    const result = await preflight({ tty: false, deps });
    expect(result.ok).toBe(true);
  });
});
