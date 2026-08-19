import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mount } from "../config-core/types";
import {
  branchReattachWarning,
  computeBuildInputsHash,
  computeBuildInputsHashFromFiles,
  debugEgressReattachWarning,
  decideReattachAction,
  findUnattachedCredentialBundles,
} from "./drift";

const CF = "FROM openlock-core\nRUN echo hi\n";
const POLICY = "endpoints:\n  - api.github.com\n";
const mount = (over: Partial<Mount> = {}): Mount => ({
  source: "/host/a",
  target: "/sandbox/.openlock/a",
  type: "copy-once",
  ...over,
});

describe("computeBuildInputsHash", () => {
  it("returns a 64-char hex sha256", () => {
    const h = computeBuildInputsHash(CF, [mount()], POLICY);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    expect(computeBuildInputsHash(CF, [mount()], POLICY)).toBe(
      computeBuildInputsHash(CF, [mount()], POLICY),
    );
  });

  it("changes when the Containerfile changes", () => {
    expect(computeBuildInputsHash(CF, [mount()], POLICY)).not.toBe(
      computeBuildInputsHash(`${CF}RUN echo more\n`, [mount()], POLICY),
    );
  });

  it("changes when policy content changes", () => {
    expect(computeBuildInputsHash(CF, [mount()], POLICY)).not.toBe(
      computeBuildInputsHash(CF, [mount()], `${POLICY}  - example.com\n`),
    );
  });

  it("changes when a mount is added", () => {
    expect(computeBuildInputsHash(CF, [mount()], POLICY)).not.toBe(
      computeBuildInputsHash(
        CF,
        [mount(), mount({ source: "/host/b", target: "/sandbox/.openlock/b" })],
        POLICY,
      ),
    );
  });

  it("changes when a mount field changes", () => {
    expect(computeBuildInputsHash(CF, [mount()], POLICY)).not.toBe(
      computeBuildInputsHash(CF, [mount({ type: "bind" })], POLICY),
    );
  });

  it("is independent of mount ordering (same set = same hash)", () => {
    const a = mount({ source: "/host/a", target: "/sandbox/.openlock/a" });
    const b = mount({ source: "/host/b", target: "/sandbox/.openlock/b" });
    expect(computeBuildInputsHash(CF, [a, b], POLICY)).toBe(
      computeBuildInputsHash(CF, [b, a], POLICY),
    );
  });

  it("is independent of mount-object key order", () => {
    const canonical: Mount = {
      source: "/host/a",
      target: "/sandbox/.openlock/a",
      type: "bind",
      readOnly: true,
    };
    const shuffled = {
      readOnly: true,
      type: "bind",
      target: "/sandbox/.openlock/a",
      source: "/host/a",
    } as Mount;
    expect(computeBuildInputsHash(CF, [canonical], POLICY)).toBe(
      computeBuildInputsHash(CF, [shuffled], POLICY),
    );
  });
});

describe("decideReattachAction", () => {
  it("proceeds when the stored hash is undefined (legacy session)", () => {
    expect(
      decideReattachAction({
        storedHash: undefined,
        currentHash: "abc",
        rebuildFlag: false,
        interactive: true,
      }),
    ).toBe("proceed");
  });

  it("proceeds when hashes match (no drift)", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: "abc",
        rebuildFlag: false,
        interactive: true,
      }),
    ).toBe("proceed");
  });

  it("rebuilds on drift when --rebuild is passed, without prompting", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: "def",
        rebuildFlag: true,
        interactive: true,
      }),
    ).toBe("rebuild");
  });

  it("prompts on drift in an interactive terminal", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: "def",
        rebuildFlag: false,
        interactive: true,
      }),
    ).toBe("prompt");
  });

  it("warns and keeps the stale container on drift with no TTY and no --rebuild", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: "def",
        rebuildFlag: false,
        interactive: false,
      }),
    ).toBe("warn-stale");
  });

  it("honors --rebuild even without a TTY", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: "def",
        rebuildFlag: true,
        interactive: false,
      }),
    ).toBe("rebuild");
  });

  it("honors --rebuild even when there is no drift (explicit intent wins)", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: "abc",
        rebuildFlag: true,
        interactive: false,
      }),
    ).toBe("rebuild");
  });

  it("honors --rebuild on a legacy session with no stored hash", () => {
    expect(
      decideReattachAction({
        storedHash: undefined,
        currentHash: "abc",
        rebuildFlag: true,
        interactive: false,
      }),
    ).toBe("rebuild");
  });

  it("proceeds when currentHash is undefined (can't compare) without --rebuild", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: undefined,
        rebuildFlag: false,
        interactive: true,
      }),
    ).toBe("proceed");
  });

  it("honors --rebuild even when currentHash is undefined", () => {
    expect(
      decideReattachAction({
        storedHash: "abc",
        currentHash: undefined,
        rebuildFlag: true,
        interactive: false,
      }),
    ).toBe("rebuild");
  });
});

describe("findUnattachedCredentialBundles (openlock-04t)", () => {
  it("returns the declared bundle that was never attached at create time", () => {
    expect(findUnattachedCredentialBundles(["github"], [])).toEqual(["github"]);
  });

  it("returns empty when the declared set matches the recorded set exactly", () => {
    expect(findUnattachedCredentialBundles(["github", "npm"], ["github", "npm"])).toEqual([]);
  });

  it("returns only the names NOT present in the recorded set (partial overlap)", () => {
    expect(findUnattachedCredentialBundles(["github", "npm"], ["github"])).toEqual(["npm"]);
  });

  it("returns empty when nothing is declared, regardless of what was recorded", () => {
    expect(findUnattachedCredentialBundles([], ["github"])).toEqual([]);
  });

  // The migration-safety case: a legacy session predates this field entirely.
  // `undefined` must NOT be read as "recorded empty" (which would warn about
  // every declared bundle on every legacy session's very next reattach) —
  // same "can't compare, never a false positive" contract as
  // decideReattachAction's storedHash.
  it("returns empty (never warns) when recordedAttached is undefined — a legacy session, not a genuinely-empty one", () => {
    expect(findUnattachedCredentialBundles(["github"], undefined)).toEqual([]);
  });

  it("distinguishes undefined (legacy/unknown) from [] (genuinely nothing attached) — [] DOES flag drift", () => {
    expect(findUnattachedCredentialBundles(["github"], undefined)).toEqual([]);
    expect(findUnattachedCredentialBundles(["github"], [])).toEqual(["github"]);
  });

  it("is order-independent for the recorded set", () => {
    expect(findUnattachedCredentialBundles(["a", "b"], ["b", "a"])).toEqual([]);
  });
});

describe("computeBuildInputsHashFromFiles", () => {
  function tmp(): { dir: string; cf: string; policy: string } {
    const dir = mkdtempSync(join(tmpdir(), "drift-"));
    const cf = join(dir, "Containerfile");
    const policy = join(dir, "policy.yaml");
    writeFileSync(cf, "FROM openlock-core\n");
    writeFileSync(policy, "endpoints:\n  - api.github.com\n");
    return { dir, cf, policy };
  }

  it("matches computeBuildInputsHash for the same content", () => {
    const { dir, cf, policy } = tmp();
    try {
      const mounts: Mount[] = [
        { source: "/h/a", target: "/sandbox/.openlock/a", type: "copy-once" },
      ];
      const fromFiles = computeBuildInputsHashFromFiles(cf, mounts, policy);
      const direct = computeBuildInputsHash(
        "FROM openlock-core\n",
        mounts,
        "endpoints:\n  - api.github.com\n",
      );
      expect(fromFiles).toBe(direct);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the Containerfile is missing", () => {
    const { dir, policy } = tmp();
    try {
      expect(computeBuildInputsHashFromFiles(join(dir, "nope"), [], policy)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the policy file is missing", () => {
    const { dir, cf } = tmp();
    try {
      expect(computeBuildInputsHashFromFiles(cf, [], join(dir, "nope.yaml"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("debugEgressReattachWarning (openlock-tgfk)", () => {
  it("returns null when --debug-egress was not requested, regardless of recorded value", () => {
    expect(debugEgressReattachWarning("my-session", false, true)).toBeNull();
    expect(debugEgressReattachWarning("my-session", false, false)).toBeNull();
    expect(debugEgressReattachWarning("my-session", false, undefined)).toBeNull();
  });

  it("returns null when requested AND the sandbox was already created with --debug-egress (already satisfied)", () => {
    expect(debugEgressReattachWarning("my-session", true, true)).toBeNull();
  });

  it("warns with the KNOWN consequence when requested but recorded as created WITHOUT it", () => {
    const warning = debugEgressReattachWarning("my-session", true, false);
    expect(warning).not.toBeNull();
    expect(warning).toContain('"my-session"');
    expect(warning).toContain("--rebuild");
    expect(warning).toContain("WITHOUT it");
    expect(warning).toContain("NO debug lines");
  });

  it("warns with HEDGED wording (not a confident 'NO debug lines' claim) when the recorded value is unknown (legacy session)", () => {
    const warning = debugEgressReattachWarning("my-session", true, undefined);
    expect(warning).not.toBeNull();
    expect(warning).toContain('"my-session"');
    expect(warning).toContain("--rebuild");
    expect(warning).toContain("does not know");
    // Must NOT assert the confident, possibly-false claim used in the known-mismatch case.
    expect(warning).not.toContain("NO debug lines");
  });
});

describe("branchReattachWarning (openlock-tgfk)", () => {
  it("returns null when --branch was not passed, regardless of recorded value", () => {
    expect(branchReattachWarning("my-session", undefined, "main")).toBeNull();
    expect(branchReattachWarning("my-session", undefined, null)).toBeNull();
    expect(branchReattachWarning("my-session", undefined, undefined)).toBeNull();
  });

  it("returns null when the requested branch matches what was recorded at create (already satisfied)", () => {
    expect(branchReattachWarning("my-session", "feature/x", "feature/x")).toBeNull();
  });

  it("warns naming both branches when requested differs from the recorded branch", () => {
    const warning = branchReattachWarning("my-session", "feature/x", "main");
    expect(warning).not.toBeNull();
    expect(warning).toContain('"my-session"');
    expect(warning).toContain("feature/x");
    expect(warning).toContain('"main"');
    expect(warning).toContain("--rebuild");
  });

  it("warns naming the requested branch when the sandbox was recorded as created with NO branch", () => {
    const warning = branchReattachWarning("my-session", "feature/x", null);
    expect(warning).not.toBeNull();
    expect(warning).toContain("without a --branch");
    expect(warning).toContain("feature/x");
  });

  it("warns with HEDGED wording when the recorded branch is unknown (legacy session)", () => {
    const warning = branchReattachWarning("my-session", "feature/x", undefined);
    expect(warning).not.toBeNull();
    expect(warning).toContain('"my-session"');
    expect(warning).toContain("feature/x");
    expect(warning).toContain("--rebuild");
    expect(warning).toContain("does not know which branch");
  });
});
