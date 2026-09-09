// Live integration test for openlock's OWN `sandbox create` path (as opposed
// to the sibling tests, which all drive the vendored `openshell` CLI
// directly). Fork v0.9.0 (upstream v0.0.116, #2726 "canonical main process")
// made `--upload` illegal alongside a trailing command, so
// src/sandbox/container.ts + src/sandbox/session.ts were rewritten to
// create --detach, `sandbox upload` the staging dir once Ready, `exec touch`
// a completion marker, and have the in-container setup script block on that
// marker before cloning the uploaded bundle. Nothing in CI runs `openlock
// sandbox` end-to-end today, so that detach -> upload -> marker -> setup
// script sequence is unverified at runtime — this test closes that gap.
//
// Falsification: revert buildSetupCmd's marker wait (session.ts) or
// uploadStagingToSandbox (container.ts) and this test must fail on the
// `.git`/marker checks below — the sandbox would come up before the bundle
// (or the marker) ever landed.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderInitFiles } from "../../src/cli/init";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import type { CredentialsFileV2 } from "../../src/tokens";
import { requireDisposableHost } from "./helpers/disposable-host";
import { deleteSandboxAndWait } from "./helpers/gateway-teardown";
import { spawnAndCapture } from "./helpers/sandbox-lifecycle";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");

async function spawnAndCaptureEnv(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function gitInit(dir: string): Promise<void> {
  const init = await spawnAndCapture(["git", "init", "-q", "-b", "main"], dir);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
  writeFileSync(join(dir, "README"), "openlock-create-flow fixture repo\n");
  const add = await spawnAndCapture(["git", "add", "README"], dir);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = await spawnAndCapture(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    dir,
  );
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
}

describe("openlock sandbox create -> upload -> marker -> setup script (live integration)", () => {
  // openlock-18c: see sibling live tests for the full mechanism writeup
  // (bun test timeout runs afterEach/afterAll but not an in-body
  // try/finally, so cleanup lives in a describe-scoped afterAll keyed off a
  // name set as soon as it's known — not in a `finally`). NOT a prefix
  // sweep — only the exact name this run registers is ever deleted.
  let registeredSandbox: string | null = null;
  let tmp: string | null = null;
  let configDir: string | null = null;

  afterAll(async () => {
    if (registeredSandbox !== null) {
      const env = {
        ...process.env,
        OPENLOCK_CONFIG_DIR: configDir ?? "",
        OPENLOCK_DISPOSABLE_HOST: "1",
      };
      const cleanResult = await spawnAndCaptureEnv(
        ["bun", "run", CLI_PATH, "clean", registeredSandbox],
        REPO_ROOT,
        env,
      );
      if (cleanResult.code !== 0) {
        // Fallback: `openlock clean` itself failed (e.g. it never got far
        // enough to register the session locally) — delete the gateway-side
        // sandbox directly via the openshell CLI so a partial failure above
        // doesn't leak the container. containerName === session name (fresh
        // sessions never rename the container — see session.ts's
        // `containerName = name`).
        const cli = await getCliInvocation();
        await deleteSandboxAndWait(cli, registeredSandbox);
      }
    }
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    if (configDir !== null) rmSync(configDir, { recursive: true, force: true });
  }, 120_000);

  it.skipIf(!LIVE)(
    "sandbox create --no-attach waits for the staging upload before the setup script clones",
    async () => {
      // FIRST statement, before any mutation — this suite runs `openlock
      // sandbox`/`openlock clean` against the real (CI-job) gateway and
      // writes a synthetic credentials.json; see disposable-host.ts.
      requireDisposableHost(
        "running `openlock sandbox`/`openlock clean` end-to-end (openlock create-flow live check)",
      );

      tmp = mkdtempSync(join(tmpdir(), "openlock-create-flow-"));
      const fixtureDir = join(tmp, "fixture");
      mkdirSync(fixtureDir);
      await gitInit(fixtureDir);

      // .openlock/ scaffolded via the product's own renderer (src/cli/init.ts)
      // rather than hand-written YAML: opencode harness, git-bundle workdir
      // (isolated snapshot + clone into /sandbox/repo — the path this test
      // asserts the setup script populated), no extra mounts/env/args, no
      // credential bundles.
      const files = renderInitFiles({
        harness: "opencode",
        workdir: "git-bundle",
        extraMounts: [],
        env: {},
        args: [],
      });
      const openlockDir = join(fixtureDir, ".openlock");
      mkdirSync(openlockDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(openlockDir, name), content, "utf-8");
      }

      // Synthetic credentials via the OPENLOCK_CONFIG_DIR seam — no real
      // OpenRouter key. `ensureProvider` (src/sandbox/ensure-provider.ts)
      // self-registers this with the gateway from credentials.json alone;
      // no prior `openlock provider create` call is needed. `type` is the
      // openrouter plugin's openshellType ("generic" — src/providers/openrouter.ts).
      configDir = mkdtempSync(join(tmpdir(), "openlock-create-flow-config-"));
      const credentialsFile: CredentialsFileV2 = {
        version: 2,
        providers: {
          openrouter: {
            type: "generic",
            credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-test-1234567890abcdef" },
            created_at: new Date().toISOString(),
          },
        },
      };
      writeFileSync(join(configDir, "credentials.json"), JSON.stringify(credentialsFile), "utf-8");

      const env = { ...process.env, OPENLOCK_CONFIG_DIR: configDir, OPENLOCK_DISPOSABLE_HOST: "1" };

      const createResult = await spawnAndCaptureEnv(
        [
          "bun",
          "run",
          CLI_PATH,
          "sandbox",
          fixtureDir,
          "--no-attach",
          "--provider",
          "openrouter",
          "--harness",
          "opencode",
        ],
        REPO_ROOT,
        env,
      );
      const match = createResult.stdout.match(
        /^Session (\S+) created \(detached, harness not attached\)\.$/m,
      );
      if (createResult.code !== 0 || match === null) {
        throw new Error(
          `sandbox create did not report a detached session (code=${createResult.code}); ` +
            `stdout=${createResult.stdout}; stderr=${createResult.stderr}`,
        );
      }
      const sessionName = match[1];
      registeredSandbox = sessionName;

      // Fork v0.9.0 (#2726): the marker + bundle clone are only guaranteed
      // to have landed by the time `sandbox exec` can reach the setup
      // script's own completion — buildSetupCmd (session.ts) blocks the
      // in-container setup on STAGING_UPLOADED_MARKER (container.ts) before
      // cloning the uploaded bundle, so this probe running successfully at
      // all already proves the marker wait didn't get skipped.
      const probeCmd = [
        "for f in",
        "/sandbox/.openlock/.openlock-upload-complete",
        "/sandbox/repo/.git",
        "/sandbox/repo/README",
        "; do",
        'if [ -e "$f" ]; then echo "OK $f"; else echo "MISSING $f"; fi;',
        "done",
      ].join(" ");
      const execResult = await spawnAndCaptureEnv(
        ["bun", "run", CLI_PATH, "exec", sessionName, "--", "/bin/bash", "-c", probeCmd],
        REPO_ROOT,
        env,
      );
      if (execResult.code !== 0 || /^MISSING /m.test(execResult.stdout)) {
        // Diagnostic for the setup script (the canonical main process): who
        // it ran as, what landed under /sandbox, and whether the clone works
        // by hand. Printed before the assertions fail so CI states WHY.
        const diag = await spawnAndCaptureEnv(
          [
            "bun",
            "run",
            CLI_PATH,
            "exec",
            sessionName,
            "--",
            "/bin/bash",
            "-c",
            "id; echo HOME=$HOME PWD=$PWD; git --version; ls -la /sandbox /sandbox/repo /sandbox/.openlock /sandbox/.openlock/bundles 2>&1; " +
              "cd /sandbox && git clone .openlock/bundles/repo.bundle /tmp/clone-probe 2>&1; echo clone_exit=$?; " +
              "cat /proc/1/cmdline 2>/dev/null | tr '\\0' ' '; echo; ps -eo pid,user,args 2>/dev/null | head -20",
          ],
          REPO_ROOT,
          env,
        );
        console.error(
          `--- create-flow diagnostics (exit ${diag.code}) ---\n${diag.stdout}\n${diag.stderr}\n--- end ---`,
        );
      }
      expect(execResult.code).toBe(0);
      expect(execResult.stdout).not.toMatch(/^MISSING /m);
      expect(execResult.stdout).toMatch(/^OK \/sandbox\/\.openlock\/\.openlock-upload-complete$/m);
      expect(execResult.stdout).toMatch(/^OK \/sandbox\/repo\/\.git$/m);
      expect(execResult.stdout).toMatch(/^OK \/sandbox\/repo\/README$/m);
    },
    240_000,
  );
});
