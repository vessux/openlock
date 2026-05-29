// Live integration smoke for M5 slim-images. Proves:
//   1. containers/base.Containerfile builds end-to-end via ensureBase()
//      (tarball-slim node + uv installs work, sandbox user is created).
//   2. seedContainerfile({harnesses:["claude_code"]}) + ensureSandbox()
//      produces a usable image with /usr/local/bin/claude present.
//
// Gated behind OPENLOCK_LIVE_INTEGRATION=1. First-run build takes 2-3
// minutes (~310MB base + ~330MB claude-code layer). Cached on subsequent
// runs.

import { describe, expect, it } from "bun:test";
import { computeBaseTag, ensureBase } from "../../src/sandbox/ensure-base";
import { BASE_CONTAINERFILE, ensureSandbox } from "../../src/sandbox/image-build";
import { seedContainerfile } from "../../src/sandbox/seed-containerfile";

const LIVE = process.env.OPENLOCK_LIVE_INTEGRATION === "1";

describe.skipIf(!LIVE)("slim-images live build", () => {
  it("builds base image from embedded Containerfile", async () => {
    const tag = await ensureBase(BASE_CONTAINERFILE);
    expect(tag).toMatch(/^ghcr\.io\/vessux\/openlock-base:[0-9a-f]{12}$/);
  }, 180_000);

  it("builds a sandbox image with claude_code and resolves /usr/local/bin/claude", async () => {
    const baseHash = computeBaseTag(BASE_CONTAINERFILE).split(":").pop();
    if (!baseHash) throw new Error("baseHash null");

    const userContent = seedContainerfile({
      harnesses: ["claude_code"],
      baseHash,
      baseContent: BASE_CONTAINERFILE,
    });

    const tag = await ensureSandbox(userContent);
    expect(tag).toMatch(/^openlock-sandbox:[0-9a-f]{12}$/);

    // Sanity: claude binary present at expected path.
    const proc = Bun.spawn(["podman", "run", "--rm", tag, "which", "claude"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("/usr/local/bin/claude");
  }, 240_000);
});
