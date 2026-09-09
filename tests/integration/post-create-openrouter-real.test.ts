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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOpenshellExecArgv } from "../../src/sandbox/container";
import { startGateway } from "../../src/sandbox/ensure-gateway";
import { getCliInvocation } from "../../src/sandbox/fork-binaries";
import { BASE_CONTAINERFILE, ensureImage } from "../../src/sandbox/image-build";
import { teardownGatewayState } from "./helpers/gateway-teardown";
import { loadRealOpenRouterBearerForLiveIntegrationOnly } from "./helpers/real-credentials";
import { createDetachedSandbox, spawnAndCapture } from "./helpers/sandbox-lifecycle";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";

// openlock-q7b8: the real-credentials.json read moved to
// tests/integration/helpers/real-credentials.ts — that is now the ONLY
// sanctioned place in the tree allowed to construct this path (enforced by
// scripts/check-real-state-access.ts). This call is unconditional at module
// scope, same as before the extraction, because `it.skipIf` below needs
// BEARER's value at collection time to decide whether to skip — but the
// helper itself now checks OPENLOCK_LIVE_INTEGRATION internally and returns
// null without touching disk at all when it isn't "1", so a plain
// `bun run test` no longer reads the real file even read-only (a
// strengthening over the pre-extraction behavior, which read it
// unconditionally regardless of LIVE).
const BEARER = loadRealOpenRouterBearerForLiveIntegrationOnly();
const PROVIDER_NAME = "openlock-test-or-real";
const FIXTURE_POLICY = resolve(
  __dirname,
  "../fixtures/policies/test-openrouter-real-upstream.yaml",
);

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

describe("post-create exec reaches authenticated OpenRouter (openlock-hnp e2e)", () => {
  // openlock-18c: see harness-binary-cred-inject.test.ts for the full
  // mechanism writeup (bun test timeout runs afterEach/afterAll but not an
  // in-body try/finally). Also fixes the same second bug as its siblings:
  // `removeContainer` did a raw `podman rm -f`, never `sandbox delete`,
  // leaving the gateway's own sandbox record behind even on a clean run.
  // Fork v0.9.0 (#2726): `sandbox create --detach` returns once the sandbox
  // exists rather than staying attached to a foreground command — see
  // post-create-exec-proxy.test.ts for why this suite no longer tracks/reaps
  // a long-lived `create` child. NOT a prefix sweep — only the exact name(s)
  // this run registers are ever deleted; this suite runs against the real
  // dev gateway.
  let registeredSandbox: string | null = null;
  let registeredProvider: string | null = null;

  afterAll(
    async () => {
      if (registeredSandbox === null && registeredProvider === null) return;
      const cli = await getCliInvocation();
      await teardownGatewayState(cli, registeredSandbox, registeredProvider);
    },
    // openlock-18c: explicit timeout required — hooks default to 5000ms
    // regardless of the `it`'s own budget, and podman teardown exceeds that.
    // See harness-binary-cred-inject.test.ts's afterAll for the full story.
    120_000,
  );

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

        // Fork v0.9.0 (#2726): create's main process is the placeholder
        // `sleep infinity`; `createDetachedSandbox` runs `sandbox create
        // --detach` (returns once the sandbox exists, not once the main
        // process exits) and polls until Ready — see
        // post-create-exec-proxy.test.ts for the fuller writeup.
        await createDetachedSandbox(
          argvHead,
          {
            name: sessionName,
            image: image.tag,
            policy: FIXTURE_POLICY,
            providers: [PROVIDER_NAME],
          },
          cli.cwd,
        );

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
      } finally {
        // Gateway-side cleanup (sandbox, provider) lives in the describe's
        // `afterAll` above, which survives a timeout this `finally` would
        // not — see openlock-18c comment there.
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
