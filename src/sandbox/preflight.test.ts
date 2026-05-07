import { describe, it, expect } from "bun:test";
import { preflight, type PreflightDeps } from "./preflight";

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    runDoctorChecks: async () => [
      { name: "git", ok: true },
      { name: "podman", ok: true },
      { name: "podman machine (running)", ok: true },
      { name: "credentials (openlock login)", ok: true },
    ],
    readToken: () => "tok",
    isMac: true,
    podmanMachineRunning: async () => true,
    confirmStartMachine: async () => true,
    startPodmanMachine: async () => true,
    podmanSocketActive: async () => true,
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
      startPodmanMachine: async () => {
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

  it("runs login() inline when token missing + tty", async () => {
    let logged = false;
    let token: string | null = null;
    const deps = makeDeps({
      readToken: () => token,
      login: async () => {
        logged = true;
        token = "tok";
      },
    });
    const result = await preflight({ tty: true, deps });
    expect(logged).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("fails when token missing + non-tty", async () => {
    const deps = makeDeps({
      readToken: () => null,
    });
    const result = await preflight({ tty: false, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("openlock login");
  });
});
