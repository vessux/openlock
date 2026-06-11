import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateBaseCmd } from "./update-base";

function setup(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "openlock-ub-test-"));
  mkdirSync(join(dir, ".openlock"));
  writeFileSync(join(dir, ".openlock/Containerfile"), content);
  return dir;
}

describe("updateBaseCmd", () => {
  it("rewrites FROM to current embedded hash", async () => {
    const original = `FROM ghcr.io/vessux/openlock-base:OLDHASH123abc

ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000

# ---- Harness ---------------------------------------------------------------
USER root
RUN npm install -g preserved
USER \${SANDBOX_UID}:\${SANDBOX_GID}
`;
    const dir = setup(original);
    try {
      const exitCode = await updateBaseCmd(["--project", dir]);
      expect(exitCode).toBe(0);
      const after = readFileSync(join(dir, ".openlock/Containerfile"), "utf-8");
      expect(after).not.toContain("OLDHASH123abc");
      expect(after).toMatch(/FROM ghcr\.io\/vessux\/openlock-base:[0-9a-f]{12}/);
      expect(after).toContain("RUN npm install -g preserved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors if Containerfile missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openlock-ub-test-"));
    try {
      const exitCode = await updateBaseCmd(["--project", dir]);
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors if sentinel missing", async () => {
    const dir = setup("FROM ghcr.io/vessux/openlock-base:OLD\nRUN x\n");
    try {
      const exitCode = await updateBaseCmd(["--project", dir]);
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
