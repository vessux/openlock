// Integration test (seed): validates the storage-side plumbing for the OpenRouter
// provider record — writeProvider round-trips through readProvider cleanly.
//
// Gated behind BOTH:
//   OPENLOCK_LIVE_INTEGRATION=1  — shared live-integration gate (requires podman etc.)
//   OPENROUTER_API_KEY           — repo secret; absent in forks/local runs by default
//
// The full end-to-end test ("opencode binary inside the sandbox reaches openrouter.ai
// via the gateway with strip-replace at HTTP egress") is deferred to a follow-up
// bd issue (xoz-providers-test-live). It requires the heavy sandbox-image build +
// gateway setup pattern already used in harness-cred-inject.test.ts.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProvider, writeProvider } from "../../src/tokens";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";
const HAS_KEY = Boolean(process.env.OPENROUTER_API_KEY);

const condRun = LIVE && HAS_KEY ? describe : describe.skip;

condRun("live: openrouter provider plumbing", () => {
  it("writes and reads back an openrouter provider record", () => {
    const dir = mkdtempSync(join(tmpdir(), "openlock-or-live-"));
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      writeProvider("openrouter", {
        type: "openrouter",
        credentials: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "" },
        created_at: new Date().toISOString(),
      });
      const r = readProvider("openrouter");
      expect(r?.credentials.OPENROUTER_API_KEY).toBe(process.env.OPENROUTER_API_KEY ?? "");
      expect(r?.type).toBe("openrouter");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
