import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../runtime";
import {
  BASE_CONTAINERFILE,
  buildImageBuildArgv,
  buildImageExistsArgv,
  computeImageTag,
  contextDirForHash,
  ensureSandbox,
} from "./image-build";

describe("computeImageTag", () => {
  it("returns prefix:hash with 12-char hex hash", () => {
    const tag = computeImageTag("hello world", "openlock-core");
    expect(tag).toMatch(/^openlock-core:[0-9a-f]{12}$/);
  });

  it("is deterministic for same content + prefix", () => {
    const a = computeImageTag("FROM ubuntu", "openlock-core");
    const b = computeImageTag("FROM ubuntu", "openlock-core");
    expect(a).toBe(b);
  });

  it("differs when content differs", () => {
    const a = computeImageTag("FROM ubuntu", "openlock-core");
    const b = computeImageTag("FROM ubuntu\n", "openlock-core");
    expect(a).not.toBe(b);
  });

  it("differs when prefix differs but hash portion is the same", () => {
    const a = computeImageTag("FROM ubuntu", "openlock-core");
    const b = computeImageTag("FROM ubuntu", "openlock-core-js");
    expect(a).not.toBe(b);
    const aHash = a.split(":")[1];
    const bHash = b.split(":")[1];
    expect(aHash).toBe(bHash); // hash depends only on content
  });
});

describe("contextDirForHash", () => {
  it("returns a path under ~/.cache/openlock/build-context", () => {
    const p = contextDirForHash("a1b2c3d4e5f6");
    expect(p).toBe(join(homedir(), ".cache", "openlock", "build-context", "a1b2c3d4e5f6"));
  });
});

describe("buildImageExistsArgv", () => {
  it.each<[Runtime, string[]]>([
    ["podman", ["podman", "image", "exists", "foo:bar"]],
    ["docker", ["docker", "image", "inspect", "foo:bar"]],
  ])("uses correct argv for %s", (runtime, expected) => {
    expect(buildImageExistsArgv(runtime, "foo:bar")).toEqual(expected);
  });
});

describe("buildImageBuildArgv", () => {
  it("podman without no-cache", () => {
    expect(buildImageBuildArgv("podman", "t:1", "/ctx")).toEqual([
      "podman",
      "build",
      "-t",
      "t:1",
      "/ctx",
    ]);
  });
  it("docker without no-cache", () => {
    expect(buildImageBuildArgv("docker", "t:1", "/ctx")).toEqual([
      "docker",
      "build",
      "-t",
      "t:1",
      "/ctx",
    ]);
  });
  it("podman with no-cache", () => {
    expect(buildImageBuildArgv("podman", "t:1", "/ctx", true)).toEqual([
      "podman",
      "build",
      "-t",
      "t:1",
      "--no-cache",
      "/ctx",
    ]);
  });
  it("docker with no-cache", () => {
    expect(buildImageBuildArgv("docker", "t:1", "/ctx", true)).toEqual([
      "docker",
      "build",
      "-t",
      "t:1",
      "--no-cache",
      "/ctx",
    ]);
  });
});

describe("BASE_CONTAINERFILE", () => {
  // openlock-jsfo: the base image never installed nftables, so the
  // supervisor's per-sandbox netns fence silently degraded to routing-only
  // isolation (fast-fail lost, bypass detection dead). This is an offline,
  // package-list-only regression guard — it does not prove the resulting
  // image actually works (that's the live `which nft` assertion in
  // tests/integration/slim-images.test.ts) nor that bypass detection is
  // restored (it isn't — see openlock-pc5e, a separate rootless-podman
  // dmesg_restrict problem `nftables` cannot fix).
  it("installs nftables in the apt package list", () => {
    const installLine = BASE_CONTAINERFILE.split("\n").find((l) =>
      l.trim().startsWith("ca-certificates"),
    );
    expect(installLine).toBeDefined();
    expect(installLine?.split(/\s+/)).toContain("nftables");
  });
});

describe("ensureSandbox", () => {
  it("calls ensureBase when FROM starts with openlock-base prefix", async () => {
    let baseEnsured = false;
    const userContent = "FROM ghcr.io/vessux/openlock-base:abc\nRUN echo hi\n";
    await ensureSandbox(userContent, undefined, {
      ensureBase: async () => {
        baseEnsured = true;
        return "ghcr.io/vessux/openlock-base:abc";
      },
      imageExists: async () => true,
      build: async () => {
        throw new Error("should not build user tag");
      },
    });
    expect(baseEnsured).toBe(true);
  });

  it("skips ensureBase for third-party FROM", async () => {
    let baseEnsured = false;
    const userContent = "FROM custom-registry.example/img:1\nRUN x\n";
    await ensureSandbox(userContent, undefined, {
      ensureBase: async () => {
        baseEnsured = true;
        return "...";
      },
      imageExists: async () => true,
      build: async () => {},
    });
    expect(baseEnsured).toBe(false);
  });

  it("builds when user-tag image not present", async () => {
    let built = false;
    const userContent = "FROM ghcr.io/vessux/openlock-base:abc\n";
    await ensureSandbox(userContent, undefined, {
      ensureBase: async () => "ghcr.io/vessux/openlock-base:abc",
      imageExists: async () => false,
      build: async () => {
        built = true;
      },
    });
    expect(built).toBe(true);
  });

  it("rebuild forces a build even when the image exists, with noCache+pull", async () => {
    let builtWith: { noCache?: boolean; pull?: boolean } | undefined = { noCache: false };
    await ensureSandbox(
      "FROM ghcr.io/vessux/openlock-base:abc\n",
      { rebuild: true },
      {
        ensureBase: async () => "ghcr.io/vessux/openlock-base:abc",
        // Image already exists — rebuild must bypass this short-circuit.
        imageExists: async () => true,
        build: async (_rt, _tag, _ctx, opts) => {
          builtWith = opts;
        },
      },
    );
    expect(builtWith).toEqual({ noCache: true, pull: true });
  });

  it("returns openlock-sandbox-prefixed tag", async () => {
    const tag = await ensureSandbox("FROM ghcr.io/vessux/openlock-base:abc\n", undefined, {
      ensureBase: async () => "ghcr.io/vessux/openlock-base:abc",
      imageExists: async () => true,
      build: async () => {},
    });
    expect(tag).toMatch(/^openlock-sandbox:[0-9a-f]{12}$/);
  });
});

// openlock-jyk: proves the lock wiring on ensureSandbox's user-tag
// check-then-build site — the real `openlock sandbox` production path
// (session.ts -> ensureSandbox). Deliberately in-process and deterministic
// via the existing EnsureSandboxDeps injection rather than real subprocess
// contention: withLock's own cross-process semantics are already covered in
// ../lock.test.ts (and end-to-end for ensureImage in
// image-build-lock.test.ts); what's unproven here is WIRING — that
// ensureSandbox's closure actually runs inside the lock and behaves like
// ensureImage's reference shape.
describe("ensureSandbox lock wiring (openlock-jyk)", () => {
  it("re-checks imageExists INSIDE the lock — a build finished by someone else while we waited is honored, not redone", async () => {
    let calls = 0;
    const tag = await ensureSandbox("FROM ghcr.io/vessux/openlock-base:abc\n", undefined, {
      ensureBase: async () => "ghcr.io/vessux/openlock-base:abc",
      // false on the unlocked fast-path check, true on the locked re-check —
      // simulates another process finishing its build while we waited.
      imageExists: async () => {
        calls++;
        return calls > 1;
      },
      build: async () => {
        throw new Error("should not build — the locked re-check should have short-circuited");
      },
    });
    expect(tag).toMatch(/^openlock-sandbox:[0-9a-f]{12}$/);
    expect(calls).toBe(2);
  });

  it("releases the lock after a failed build so an independent later call can retry and succeed (jp2 resilience)", async () => {
    const userContent = "FROM ghcr.io/vessux/openlock-base:lock-retry\n";
    const deps = {
      ensureBase: async () => "ghcr.io/vessux/openlock-base:lock-retry",
      imageExists: async () => false,
    };

    await expect(
      ensureSandbox(userContent, undefined, {
        ...deps,
        build: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    // Same content -> same tag -> same lock path. If the failed attempt
    // above hadn't released the lock, this would hang (and the test's
    // default timeout would fail it) instead of succeeding.
    const tag = await ensureSandbox(userContent, undefined, {
      ...deps,
      build: async () => {},
    });
    expect(tag).toMatch(/^openlock-sandbox:[0-9a-f]{12}$/);
  });
});
