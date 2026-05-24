import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import { _renderProvidersTable } from "./providers";

let dir: string;
let originalHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-providers-"));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("_renderProvidersTable", () => {
  it("shows stored=no for unconfigured providers", () => {
    const lines = _renderProvidersTable({ inGateway: new Set(), getStored: (_id) => null });
    const openrouterLine = lines.find((l) => l.startsWith("openrouter"))!;
    expect(openrouterLine).toContain("stored=no");
    expect(openrouterLine).toContain("in_gateway=no");
  });

  it("reflects stored + gateway state", () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_API_KEY: "sk-or-v1-x" },
      created_at: "t",
    });
    const lines = _renderProvidersTable({
      inGateway: new Set(["openrouter"]),
      getStored: (id) => (id === "openrouter" ? {} : null),
    });
    const line = lines.find((l) => l.startsWith("openrouter"))!;
    expect(line).toContain("stored=yes");
    expect(line).toContain("in_gateway=yes");
  });
});
