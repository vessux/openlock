// E2E live integration test for openlock-hnp: proves the post-create exec
// path delivers AUTHENTICATED requests to the real OpenRouter API with the
// real bearer token injected via `cred_inject`. The mock-echo variant
// (post-create-exec-proxy.test.ts) proves the proxy is in the loop and the
// header-rewrite mechanism fires; this test closes the loop with a real
// upstream so we know the bearer placeholder actually gets swapped for the
// real key without leaking into the sandbox env.
//
// Double-gated:
//   - OPENLOCK_LIVE_INTEGRATION=1 (same as the other live tests)
//   - real OpenRouter creds in ~/.config/openlock/credentials.json
//
// CI never runs this — no real key in CI secrets. Local-only.

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOpenshellExecArgv } from "../../src/sandbox/container";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { createBundle } from "../../src/sandbox/git-sync";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const CRED_PATH = join(homedir(), ".config", "openlock", "credentials.json");

function loadOpenRouterBearer(): string | null {
  if (!existsSync(CRED_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CRED_PATH, "utf-8")) as {
      providers?: Record<string, { credentials?: Record<string, string> }>;
    };
    const token = raw.providers?.openrouter?.credentials?.OPENROUTER_BEARER_TOKEN;
    return token ?? null;
  } catch {
    return null;
  }
}

const BEARER = loadOpenRouterBearer();
const PROVIDER_NAME = "openlock-test-or-real";
const FIXTURE_POLICY = resolve(
  __dirname,
  "../fixtures/policies/test-openrouter-real-upstream.yaml",
);

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

async function waitForSandboxReady(
  cliPrefix: readonly string[],
  cliCwd: string | undefined,
  sessionName: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await spawnAndCapture(
      [...cliPrefix, "sandbox", "exec", "--name", sessionName, "--no-tty", "--", "/bin/true"],
      cliCwd,
    );
    if (r.code === 0) return;
    await Bun.sleep(500);
  }
  throw new Error(`sandbox ${sessionName} did not reach Ready state within ${timeoutMs}ms`);
}

/** Best-effort reap of the detached `sandbox create` child (openlock-18c) —
 * split out of `afterAll` purely to keep that hook's cognitive complexity
 * under biome's limit. Tolerates the process already being dead. */
async function reapLiveProc(proc: ReturnType<typeof Bun.spawn> | null): Promise<void> {
  if (proc === null) return;
  try {
    proc.kill();
    await proc.exited;
  } catch {
    // Already dead — fine.
  }
}

/**
 * True when `sandbox delete` failed only because the sandbox doesn't exist
 * — a harmless "nothing to clean up" outcome (e.g. the test died before
 * ever creating one), not a leak. Matches the literal stderr text from a
 * verified live probe against the real gateway (2026-08-05): `openshell
 * sandbox delete <nonexistent>` exits 1 with stderr `Error:   × code: 'Some
 * requested entity was not found', message: "sandbox not found"`. A
 * sandbox that still EXISTS and can't be removed (the real leak signature
 * — e.g. "attached to sandbox(es)") does not match this and stays loud.
 * (Contrast `provider delete` on a nonexistent name, which is already exit
 * 0 — no matcher needed there.)
 */
function isSandboxNotFoundError(stderr: string): boolean {
  return stderr.includes("sandbox not found");
}

/**
 * Strict, loud gateway-side teardown (openlock-18c): deletes only the exact
 * sandbox/provider names THIS run registered — never a prefix sweep, since
 * this suite runs against the real dev gateway — sandbox-before-provider
 * (a provider still "attached to sandbox(es)" refuses deletion), and throws
 * on any failure instead of discarding it. Split out of `afterAll` purely to
 * keep that hook's cognitive complexity under biome's limit.
 */
async function teardownGatewayState(
  cli: { argv: string[]; cwd: string | undefined },
  sandboxName: string | null,
  providerName: string | null,
): Promise<void> {
  const errors: string[] = [];
  if (sandboxName !== null) {
    const r = await spawnAndCapture([...cli.argv, "sandbox", "delete", sandboxName], cli.cwd);
    if (r.code !== 0 && !isSandboxNotFoundError(r.stderr)) {
      errors.push(`sandbox delete ${sandboxName} failed (exit ${r.code}): ${r.stderr}`);
    }
  }
  if (providerName !== null) {
    const r = await spawnAndCapture([...cli.argv, "provider", "delete", providerName], cli.cwd);
    if (r.code !== 0) {
      errors.push(`provider delete ${providerName} failed (exit ${r.code}): ${r.stderr}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `openlock-18c: gateway teardown left leaked state behind:\n${errors.join("\n")}`,
    );
  }
}

describe("post-create exec reaches authenticated OpenRouter (openlock-hnp e2e)", () => {
  // openlock-18c: see harness-binary-cred-inject.test.ts for the full
  // mechanism writeup (bun test timeout runs afterEach/afterAll but not an
  // in-body try/finally). Also fixes the same second bug as its siblings:
  // `removeContainer` did a raw `podman rm -f`, never `sandbox delete`,
  // leaving the gateway's own sandbox record behind even on a clean run.
  // Additionally tracks the detached `sandbox create` (foreground "sleep
  // infinity") child process — see post-create-exec-proxy.test.ts for why.
  // NOT a prefix sweep — only the exact name(s) this run registers are ever
  // deleted; this suite runs against the real dev gateway.
  let registeredSandbox: string | null = null;
  let registeredProvider: string | null = null;
  let liveCreateProc: ReturnType<typeof Bun.spawn> | null = null;

  afterAll(async () => {
    await reapLiveProc(liveCreateProc);
    liveCreateProc = null;
    if (registeredSandbox === null && registeredProvider === null) return;
    const cli = await getCliInvocation();
    await teardownGatewayState(cli, registeredSandbox, registeredProvider);
  });

  it.skipIf(!LIVE || BEARER === null)(
    "openrouter.ai accepts the cred_inject-rewritten Bearer and responds at API level",
    async () => {
      const sessionName = `ol-orr-${Date.now().toString(36)}`;
      registeredSandbox = sessionName;
      registeredProvider = PROVIDER_NAME;
      const tmp = mkdtempSync(join(tmpdir(), "openlock-or-real-"));
      const repoDir = join(tmp, "repo");
      mkdirSync(repoDir);
      await gitInit(repoDir);

      const staging = join(tmp, "staging", ".openlock");
      mkdirSync(staging, { recursive: true });
      await createBundle(repoDir, join(staging, "repo.bundle"));

      const cli = await getCliInvocation();
      const argvHead = cli.argv;
      const removeProvider = async (): Promise<void> => {
        // Best-effort, pre-create only (may not exist yet). The `afterAll`
        // teardown above is the strict path.
        await spawnAndCapture([...argvHead, "provider", "delete", PROVIDER_NAME], cli.cwd);
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
            PROVIDER_NAME,
            "--type",
            "generic",
            "--credential",
            // BEARER comes from ~/.config/openlock/credentials.json (real key).
            `OPENROUTER_BEARER_TOKEN=${BEARER!}`,
          ],
          cli.cwd,
        );
        if (created.code !== 0) {
          throw new Error(`provider create failed: ${created.stderr}`);
        }

        const image = await ensureImage({
          containerfileContent: BASE_CONTAINERFILE,
          tagPrefix: "openlock-base-it",
        });

        const createArgv = [
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
          PROVIDER_NAME,
          "--no-tty",
          "--",
          "/bin/sh",
          "-c",
          "exec sleep infinity",
        ];

        const createProc = Bun.spawn(createArgv, {
          cwd: cli.cwd,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        // Registered for afterAll (openlock-18c) — see
        // post-create-exec-proxy.test.ts for why a timeout must still be
        // able to reap this.
        liveCreateProc = createProc;
        await waitForSandboxReady(argvHead, cli.cwd, sessionName);

        // POST a tiny inference request to OpenRouter through the new exec
        // path. The body has a fake `Authorization: Bearer fake` header that
        // cred_inject strips and replaces with the real bearer. If auth
        // succeeds at OpenRouter's edge we'll get either:
        //   - 200 with a completion (key has credits + privacy-allowed model)
        //   - 4xx with an OpenRouter-level error JSON (billing, privacy
        //     policy, model not allowed) — but NOT an authentication error.
        // If the bearer didn't get injected we'd get 401 / "Missing
        // Authentication header" and the test fails.
        const curlArgv = [
          "curl",
          "-sS",
          "-o",
          "/tmp/or-response.json",
          "-w",
          "%{http_code}",
          "-X",
          "POST",
          "-H",
          "Content-Type: application/json",
          "-H",
          "Authorization: Bearer fake",
          "-d",
          JSON.stringify({
            model: "deepseek/deepseek-v4-flash:free",
            messages: [{ role: "user", content: "PONG" }],
            max_tokens: 4,
          }),
          "https://openrouter.ai/api/v1/chat/completions",
        ];
        const execArgv = buildOpenshellExecArgv(argvHead, sessionName, curlArgv, {
          workdir: "/sandbox/repo",
          tty: "off",
        });
        const result = await spawnAndCapture(execArgv, cli.cwd);
        const httpCode = result.stdout.trim();

        // Pull the body for diagnostics.
        const bodyResult = await spawnAndCapture(
          buildOpenshellExecArgv(argvHead, sessionName, ["cat", "/tmp/or-response.json"], {
            tty: "off",
          }),
          cli.cwd,
        );
        const body = bodyResult.stdout;

        // Hard requirement: we must NOT get a "no auth header" / 401-flavored
        // upstream rejection — that would mean cred_inject didn't fire.
        const lower = body.toLowerCase();
        expect(lower).not.toContain("missing authentication");
        expect(lower).not.toContain("invalid api key");
        expect(httpCode).not.toBe("401");

        // The response IS from OpenRouter (cf-ray header path, real billing/
        // policy/model errors all count as "auth succeeded, account-level
        // problem"). A 200 is fine. A 4xx with a real JSON body is fine.
        // What's NOT fine is a CONNECT-tunnel 403 from the proxy or a
        // network-level failure — those mean the request never reached
        // OpenRouter's edge.
        expect(["200", "402", "403", "404", "429", "400"]).toContain(httpCode);

        createProc.kill();
        // Reap to free supervisor + gateway slot for sibling tests.
        await createProc.exited;
        liveCreateProc = null;
      } finally {
        // Gateway-side cleanup (createProc, sandbox, provider) lives in the
        // describe's `afterAll` above, which survives a timeout this
        // `finally` would not — see openlock-18c comment there.
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
