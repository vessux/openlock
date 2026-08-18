import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessEnvFor } from "../sandbox/container";
import type { SessionMeta } from "../sandbox/session-store";
import { buildExecEnv, flagSchema } from "./exec";

describe("exec flagSchema", () => {
  it("declares only --help/-h", () => {
    expect(Object.keys(flagSchema).sort()).toEqual(["help"]);
  });
});

// Test-local fixture helpers. `emptyProject()` gives a repoPath with no
// `.openlock/` at all (isolates a test from repoConfigEnv effects — resolves
// to `{}` via the missing-project-dir degrade path). `projectWithEnv()`
// mirrors session.test.ts's `resolveRepoPolicy` fixture (config.yaml +
// minimal policy.yaml + Containerfile — resolveOpenlockFolder requires all
// three to exist before it will read config.yaml's `env:` block at all).
function emptyProject(): string {
  return mkdtempSync(join(tmpdir(), "exec-env-empty-"));
}

function projectWithEnv(envBlockYaml: string): string {
  const proj = mkdtempSync(join(tmpdir(), "exec-env-proj-"));
  const folder = join(proj, ".openlock");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "config.yaml"), `mounts: []\n${envBlockYaml}`);
  writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
  writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
  return proj;
}

function meta(
  overrides: Partial<SessionMeta> & Pick<SessionMeta, "repoPath" | "harness">,
): SessionMeta {
  return {
    id: "test-id",
    name: "sb-test",
    image: "openlock-core",
    policy: "default",
    createdAt: "2026-08-18T00:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
    ...overrides,
  };
}

describe("buildExecEnv (openlock-xz6d)", () => {
  // The reported defect, characterized directly: pre-fix, `exec.ts` only
  // ever called `harnessEnvFor(meta.harness)` — for opencode that's `{}` —
  // so `OPENROUTER_API_KEY` was NEVER present regardless of provider. This
  // pins that historical fact against the (unchanged, pre-existing)
  // `harnessEnvFor`, independent of anything this fix adds, so it can never
  // regress into a false pass just because `harnessEnvFor` itself changes
  // shape later without anyone reading this file.
  it("characterizes the historical defect: harnessEnvFor alone (opencode) carries no provider placeholder", () => {
    expect(harnessEnvFor("opencode").OPENROUTER_API_KEY).toBeUndefined();
  });

  it("injects the OPENROUTER_API_KEY placeholder for (openrouter, opencode) when providerId is recorded", () => {
    const env = buildExecEnv(
      meta({ repoPath: emptyProject(), harness: "opencode", providerId: "openrouter" }),
    );
    expect(env.OPENROUTER_API_KEY).toBe("managed-by-openlock-do-not-leak");
  });

  it("injects NO provider placeholder when providerId is absent (legacy session) — never guesses", () => {
    const env = buildExecEnv(meta({ repoPath: emptyProject(), harness: "opencode" }));
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("sets CLAUDE_CONFIG_DIR for (anthropic, claude_code) when providerId is recorded, matching the attach path", () => {
    const env = buildExecEnv(
      meta({ repoPath: emptyProject(), harness: "claude_code", providerId: "anthropic" }),
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/sandbox/.openlock/claude-config");
  });

  it("still sets harness env (CLAUDE_CONFIG_DIR) even when providerId is absent — openlock-04x must not regress", () => {
    const env = buildExecEnv(meta({ repoPath: emptyProject(), harness: "claude_code" }));
    expect(env.CLAUDE_CONFIG_DIR).toBe("/sandbox/.openlock/claude-config");
  });

  it("resolves the .openlock/config.yaml env: block fresh at exec time, matching attach's freshness contract", () => {
    const proj = projectWithEnv("env:\n  MY_VAR: hello\n");
    const env = buildExecEnv(meta({ repoPath: proj, harness: "claude_code" }));
    expect(env.MY_VAR).toBe("hello");
  });

  it("repo-config env wins over the provider placeholder when config.yaml sets the same key", () => {
    const proj = projectWithEnv("env:\n  OPENROUTER_API_KEY: user-explicitly-set\n");
    const env = buildExecEnv(
      meta({ repoPath: proj, harness: "opencode", providerId: "openrouter" }),
    );
    expect(env.OPENROUTER_API_KEY).toBe("user-explicitly-set");
  });

  // "Genuinely absent" bucket: no `.openlock/` directory at all (the project
  // dir may have moved/been deleted since the sandbox was created). This is
  // legitimate and expected — the sandbox outlives the project dir by design
  // — so it must degrade SILENTLY, with no warning printed at all.
  it("degrades to no extra repo-config env, SILENTLY, when the project directory no longer exists (moved/deleted)", () => {
    const goneDir = join(tmpdir(), "exec-env-does-not-exist-ever");
    rmSync(goneDir, { recursive: true, force: true }); // ensure it's really absent
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        buildExecEnv(meta({ repoPath: goneDir, harness: "opencode", providerId: "openrouter" })),
      ).not.toThrow();
      const env = buildExecEnv(
        meta({ repoPath: goneDir, harness: "opencode", providerId: "openrouter" }),
      );
      // Provider placeholder still applies (doesn't depend on the project dir);
      // only the repo-config slice degrades.
      expect(env.OPENROUTER_API_KEY).toBe("managed-by-openlock-do-not-leak");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // "Present but unusable" bucket: `.openlock/` exists but is INCOMPLETE
  // (missing policy.yaml/Containerfile — resolveOpenlockFolder requires all
  // three before it will read config.yaml's env: block at all). This is
  // classified here, not in the silent/absent bucket above, precisely
  // because the directory itself exists — `existsSync(join(repoPath,
  // ".openlock"))` is true, so resolveRepoConfigEnvSafely proceeds to call
  // resolveRepoPolicy, which throws. The attach path (session.ts's
  // runSandbox) treats this exact failure LOUDLY (console.error +
  // process.exit(2)); exec must warn rather than stay silent, or it
  // manufactures a NEW exec-vs-attach disagreement of the same family this
  // whole fix exists to eliminate.
  it("degrades to no extra repo-config env, but WARNS, when .openlock/ exists but is incomplete (missing policy.yaml/Containerfile)", () => {
    const proj = mkdtempSync(join(tmpdir(), "exec-env-incomplete-"));
    mkdirSync(join(proj, ".openlock"), { recursive: true });
    writeFileSync(join(proj, ".openlock", "config.yaml"), "mounts: []\nenv:\n  MY_VAR: hello\n");
    // policy.yaml and Containerfile deliberately absent.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = buildExecEnv(meta({ repoPath: proj, harness: "claude_code" }));
      expect(env.MY_VAR).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain(proj);
      expect(message).toContain("env:");
      expect(message).toContain("NOT");
      expect(message).toContain("incomplete"); // the underlying resolveOpenlockFolder error text
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Same "present but unusable" bucket, different underlying cause (a YAML
  // parse error rather than missing files) — proves the warning fires for
  // ANY resolveRepoPolicy failure once `.openlock/` is confirmed to exist,
  // not just the incomplete-folder shape.
  it("degrades to no extra repo-config env, but WARNS, when config.yaml is malformed YAML", () => {
    const proj = mkdtempSync(join(tmpdir(), "exec-env-malformed-"));
    const folder = join(proj, ".openlock");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.yaml"), "mounts: [\n  this is not valid yaml: [[[\n");
    writeFileSync(join(folder, "policy.yaml"), "version: 1\n");
    writeFileSync(join(folder, "Containerfile"), "FROM scratch\n");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = buildExecEnv(meta({ repoPath: proj, harness: "claude_code" }));
      expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/sandbox/.openlock/claude-config" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0] as string).toContain(proj);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// openlock-xz6d wiring guard, same rationale as the openlock-tgfk guard in
// session.test.ts: the reported defect was a missing CALL SITE (exec.ts
// never called anything beyond harnessEnvFor), not a missing string builder
// — buildExecEnv's own unit tests above would all still pass if execCmd
// stopped calling it and reverted to the old inline
// `meta ? harnessEnvFor(meta.harness) : {}`. A bare `toContain("buildExecEnv")`
// would be satisfied by the import statement alone, so this is scoped to the
// extracted execCmd function body specifically.
describe("execCmd wires buildExecEnv into the exec call (openlock-xz6d)", () => {
  const EXEC_TS_PATH = join(import.meta.dir, "exec.ts");
  const source = readFileSync(EXEC_TS_PATH, "utf-8");

  function extractExecCmdBody(src: string): string {
    const startMarker = "export async function execCmd(args: string[]): Promise<number> {";
    const start = src.indexOf(startMarker);
    if (start === -1) {
      throw new Error("execCmd not found in exec.ts — was it renamed or removed?");
    }
    // execCmd is the last top-level export in the file; its closing brace is
    // the file's own final line.
    return src.slice(start);
  }

  const body = extractExecCmdBody(source);

  it("computes env via buildExecEnv(meta), not a bare harnessEnvFor(meta.harness) inline", () => {
    expect(body).toContain("buildExecEnv(meta)");
  });

  it("passes that computed env into the actual exec call", () => {
    expect(body).toMatch(/runExec\(name,\s*after,\s*env\)/);
  });
});
