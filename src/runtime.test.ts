// src/runtime.test.ts
import { describe, expect, it } from "bun:test";
import {
  autodetectRuntimeFromProbes,
  parseRuntime,
  pickRuntime,
  RUNTIMES,
  type Runtime,
} from "./runtime";

describe("RUNTIMES constant", () => {
  it("contains podman and docker", () => {
    expect([...RUNTIMES]).toEqual(["podman", "docker"]);
  });
});

describe("parseRuntime", () => {
  it("accepts canonical podman", () => {
    expect(parseRuntime("podman")).toBe("podman");
  });
  it("accepts canonical docker", () => {
    expect(parseRuntime("docker")).toBe("docker");
  });
  it("trims and lowercases", () => {
    expect(parseRuntime("  Docker\n")).toBe("docker");
  });
  it("returns null for unknown", () => {
    expect(parseRuntime("nerdctl")).toBe(null);
  });
  it("returns null for empty", () => {
    expect(parseRuntime("")).toBe(null);
  });
});

describe("pickRuntime cascade", () => {
  it("prefers env over config", () => {
    expect(
      pickRuntime({
        env: "docker",
        config: "podman",
        autodetected: "podman",
      }),
    ).toBe("docker");
  });
  it("falls back to config when env unset", () => {
    expect(pickRuntime({ env: null, config: "docker", autodetected: "podman" })).toBe("docker");
  });
  it("falls back to autodetected when env+config unset", () => {
    expect(pickRuntime({ env: null, config: null, autodetected: "docker" })).toBe("docker");
  });
  it("returns null when nothing resolves", () => {
    expect(pickRuntime({ env: null, config: null, autodetected: null })).toBe(null);
  });
  it("ignores invalid env value", () => {
    expect(
      pickRuntime({
        env: "garbage" as unknown as Runtime,
        config: "podman",
        autodetected: null,
      }),
    ).toBe("podman");
  });
});

describe("autodetectRuntimeFromProbes", () => {
  it("returns podman when podman binary exists first", () => {
    expect(autodetectRuntimeFromProbes({ podman: true, docker: true })).toBe("podman");
  });
  it("returns docker when only docker exists", () => {
    expect(autodetectRuntimeFromProbes({ podman: false, docker: true })).toBe("docker");
  });
  it("returns null when neither exists", () => {
    expect(autodetectRuntimeFromProbes({ podman: false, docker: false })).toBe(null);
  });
});
