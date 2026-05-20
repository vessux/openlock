// Live integration test: proves cred_inject applies when the claude
// harness binary itself makes the outbound request, not when a generic
// HTTP client (curl/python) does. Distinguishes from
// tests/integration/harness-cred-inject.test.ts which uses curl as the
// requester — `/usr/bin/curl` becomes the matched binary, the harness
// binary entry in the policy is decorative.
//
// Here the foreground command IS the claude binary. /usr/local/bin/claude
// resolves through symlinks to claude.exe — the proxy resolves these
// symlinks at sandbox boot (see "Resolved policy binary symlink" log
// lines) so the policy's binary list matches the actual executable.
// Assertion is on the proxy's OCSF log, fetched via the openshell `logs`
// RPC after the sandbox exits: at least one HTTP ALLOWED event tied to
// our test policy proves the L7 path (and thus cred_inject) ran.
//
// Opencode is intentionally not covered here. Its boot needs reachable
// models.dev + github.com before issuing /v1/messages; synthetic echo
// for those breaks opencode's parsing, and skipping them prevents the
// messages call. The opencode half was verified manually (bd-zm4
// 2026-05-19 comment) and routing is covered by upstream-fork OPA tests.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1 because the test:
//   - requires a working podman environment (Mac or Linux),
//   - builds/uses the core sandbox image (~minutes on first run),
//   - starts the openshell gateway,
//   - runs the real harness binary (which may attempt unrelated
//     telemetry / update / model-list calls that get denied by the
//     restrictive policy — denials are expected and ignored).

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  containerfileKeyForCaps,
  DEFAULT_CONTAINERFILES,
} from "../../src/sandbox/default-containerfiles";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { ensureImage } from "../../src/sandbox/image-build";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const SECRET_VALUE = "smoke-value-harness-binary";
const FIXTURE_POLICY = resolve(__dirname, "../fixtures/policies/test-harness-binary-trigger.yaml");
const POLICY_NAME = "claude_harness_test";

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
  const cfg = await spawnAndCapture(
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
  if (cfg.code !== 0) throw new Error(`git commit failed: ${cfg.stderr}`);
}

describe("harness binary triggers cred_inject (live integration)", () => {
  it.skipIf(!LIVE)(
    `claude_code: /usr/local/bin/claude runs L7 echo via ${POLICY_NAME}`,
    async () => {
      const sessionName = `openlock-hb-claude-${Date.now().toString(36)}`;
      const providerName = "openlock-test-hb-claude";
      const tmp = mkdtempSync(join(tmpdir(), "openlock-hb-"));
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir);
      await gitInit(repoDir);

      const staging = join(tmp, "staging", ".openlock");
      mkdirSync(staging, { recursive: true });
      await createBundle(repoDir, join(staging, "repo.bundle"));

      const cli = await getCliInvocation();
      const argvHead = cli.argv;
      const removeProvider = async (): Promise<void> => {
        await spawnAndCapture([...argvHead, "provider", "delete", providerName], cli.cwd);
      };
      const removeSandbox = async (): Promise<void> => {
        // `sandbox delete` removes both the gateway-side record and
        // the podman container; without it the provider stays
        // "attached" and the next run hits AlreadyExists on create.
        await spawnAndCapture([...argvHead, "sandbox", "delete", sessionName], cli.cwd);
      };

      try {
        await startGateway();

        await removeProvider();
        const created = await spawnAndCapture(
          [
            ...argvHead,
            "provider",
            "create",
            "--name",
            providerName,
            "--type",
            "generic",
            "--credential",
            `TEST_ECHO_VAL=${SECRET_VALUE}`,
          ],
          cli.cwd,
        );
        if (created.code !== 0) {
          throw new Error(`provider create failed: ${created.stderr}`);
        }

        const imageKey = containerfileKeyForCaps([]);
        const image = await ensureImage({
          containerfileContent: DEFAULT_CONTAINERFILES[imageKey],
          tagPrefix: `openlock-${imageKey}`,
        });

        // Run claude with a fake API key and a one-shot prompt — it
        // will issue HTTP requests against api.anthropic.com which the
        // proxy intercepts via echo mode. The harness errors on the
        // unrecognized response, exit code is suppressed by `|| true`.
        const innerCmd = 'ANTHROPIC_API_KEY=fake-key /usr/local/bin/claude --print "hi" || true';

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
          FIXTURE_POLICY,
          "--provider",
          providerName,
          "--no-tty",
          "--",
          "/bin/bash",
          "-c",
          innerCmd,
        ];

        await spawnAndCapture(sandboxArgv, cli.cwd);

        // Fetch sandbox logs (OCSF shorthand) before sandbox cleanup.
        const logsResult = await spawnAndCapture(
          [...argvHead, "logs", sessionName, "-n", "2000"],
          cli.cwd,
        );
        const logs = logsResult.stdout;

        // The fixture policy allows GET/POST on /** so every claude
        // HTTP request to api.anthropic.com lands as ALLOWED with
        // cred_inject applied. The L7 event (HTTP:METHOD ALLOWED) only
        // emits when the request reaches the cred_inject branch — an
        // L4-denied connect produces no HTTP event. We require at
        // least one such line scoped to our test policy.
        //
        // The endpoint match parses the OCSF shorthand token
        // `http://<host>:<port>/<path>` from the log line. Splitting on
        // whitespace and matching token equality (rather than
        // `String.includes` or a loose regex) avoids the CodeQL
        // incomplete-URL-substring-sanitization heuristic — this is
        // log-line parsing, not URL validation.
        const lines = logs.split("\n");
        const matchesEndpoint = (line: string): boolean => {
          for (const tok of line.split(/\s+/)) {
            if (tok.startsWith("http://api.anthropic.com:443/")) return true;
          }
          return false;
        };
        const l7Hits = lines.filter(
          (l) =>
            l.includes(POLICY_NAME) &&
            matchesEndpoint(l) &&
            /\bHTTP:[A-Z]+\b/.test(l) &&
            /ALLOWED/.test(l),
        );
        if (l7Hits.length === 0) {
          // Surface a small slice of the OCSF stream for debugging
          // without flooding the bun test reporter.
          const tail = lines.filter((l) => l.includes("[OCSF")).slice(-25);
          console.error(`no L7 ALLOWED for ${POLICY_NAME} — last 25 OCSF lines:`);
          for (const l of tail) console.error(l);
        }
        expect(l7Hits.length).toBeGreaterThan(0);
      } finally {
        await removeSandbox();
        await removeProvider();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
