// Integration test: scoped npm packages (@scope/name) install via the
// default-js policy. Regression coverage for openlock-isb (bug closed
// 2026-05-20): npm's REST API encodes the scope slash as %2F, which the
// openshell-fork L7 canonicalizer rejects unless the endpoint sets
// `allow_encoded_slash: true`. Without the opt-in, every scoped install
// fails. With it, the request reaches the registry.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 (same rationale as
// harness-cred-inject.test.ts: needs podman + image build + gateway).

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicyContent } from "../../src/sandbox/default-policies";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";

async function spawnAndCapture(
  argv: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
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
  writeFileSync(join(dir, "README"), "test repo\n");
  const commit = await spawnAndCapture(
    [
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
    dir,
  );
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
}

describe("npm scoped packages via default-js policy", () => {
  it.skipIf(!LIVE)(
    "fetch of @scope%2Fname is allowed (allow_encoded_slash: true on npm endpoint)",
    async () => {
      const sessionName = `openlock-isb-${Date.now().toString(36)}`;
      const containerName = `openshell-sandbox-${sessionName}`;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-isb-"));
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir);
      await gitInit(repoDir);

      const staging = join(tmp, "staging", ".openlock");
      mkdirSync(staging, { recursive: true });
      await createBundle(repoDir, join(staging, "repo.bundle"));

      const policyPath = join(tmp, "policy.yaml");
      writeFileSync(policyPath, defaultPolicyContent());

      const cli = await getCliInvocation();
      const argvHead = cli.argv;
      const removeContainer = async (): Promise<void> => {
        await spawnAndCapture([
          process.env.OPENLOCK_RUNTIME ?? "podman",
          "rm",
          "-f",
          containerName,
        ]);
      };

      try {
        await startGateway();

        const image = await ensureImage({
          containerfileContent: BASE_CONTAINERFILE,
          tagPrefix: "openlock-base-it",
        });

        // Fetch scoped-package metadata via npm. npm encodes the slash:
        // GET /@opencode-ai%2Fplugin. Pre-fix this gets canonicalizer-
        // rejected with "request-target contains an encoded '/'". Post-fix
        // npm prints the package version and exits 0.
        const probeCmd =
          "npm view @opencode-ai/plugin version --cache /tmp/npm-cache --no-update-notifier --no-fund --no-audit";

        const sandboxArgv = [
          ...argvHead,
          "sandbox",
          "create",
          "--name",
          sessionName,
          "--from",
          image.tag,
          "--upload",
          `${join(tmp, "staging")}:/sandbox/`,
          "--no-git-ignore",
          "--policy",
          policyPath,
          "--no-tty",
          "--",
          "/bin/bash",
          "-c",
          probeCmd,
        ];

        const result = await spawnAndCapture(sandboxArgv, cli.cwd);
        expect(result.code).toBe(0);
        // npm view prints just the version string on stdout.
        expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
      } finally {
        await removeContainer();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
