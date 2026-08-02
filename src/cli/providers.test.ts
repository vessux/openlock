import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import { _renderProvidersTable, providersCmd } from "./providers";

let dir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-providers-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = dir;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
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
      credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-x" },
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

  it("defaults credential health to unknown and refresh to '-' when omitted (openlock-7mh)", () => {
    const lines = _renderProvidersTable({ inGateway: new Set(), getStored: (_id) => null });
    const line = lines.find((l) => l.startsWith("openrouter"))!;
    expect(line).toContain("credential=unknown");
    expect(line).toContain("refresh=-");
  });

  it("reports real credential health, not mere presence — expired stays visible even though in_gateway=yes", () => {
    const lines = _renderProvidersTable({
      inGateway: new Set(["anthropic"]),
      getStored: (id) => (id === "anthropic" ? {} : null),
      getCredentialHealth: (id) => (id === "anthropic" ? "expired" : "unknown"),
      getRefreshHealth: (id) => (id === "anthropic" ? "error" : null),
    });
    const line = lines.find((l) => l.startsWith("anthropic"))!;
    expect(line).toContain("in_gateway=yes");
    expect(line).toContain("credential=expired");
    expect(line).toContain("refresh=error");
  });

  it("shows a live credential distinctly from an unknown one", () => {
    const lines = _renderProvidersTable({
      inGateway: new Set(["anthropic"]),
      getStored: (id) => (id === "anthropic" ? {} : null),
      getCredentialHealth: (id) => (id === "anthropic" ? "live" : "unknown"),
      getRefreshHealth: () => "ok",
    });
    const line = lines.find((l) => l.startsWith("anthropic"))!;
    expect(line).toContain("credential=live");
    expect(line).toContain("refresh=ok");
  });
});

// These only exercise the argument-validation paths that throw BEFORE any
// network call would happen — `providersCmd(["models", "openrouter"])` with
// a real stored credential is deliberately NOT tested here, since that would
// reach getPermittedModels with the real fetchOpenRouterUserModelsFromApi
// and hit the live OpenRouter API (see openrouter-user-models.test.ts for
// the network-free coverage of that path via dependency injection).
describe("providersCmd models subcommand (argument validation only)", () => {
  it("throws a usage error when the provider id is omitted", async () => {
    await expect(providersCmd(["models"])).rejects.toThrow("Usage: openlock providers models <id>");
  });

  it("throws on an unrecognized provider id", async () => {
    await expect(providersCmd(["models", "bogus"])).rejects.toThrow(/not a recognized provider/);
  });

  // Regression guard: a positional that isn't "models" must NOT silently fall
  // through to the status table and exit 0 — a typo'd subcommand or a
  // plausible-guess syntax would otherwise report success while doing
  // something the user didn't ask for.
  it("throws on an unrecognized subcommand instead of silently printing the status table", async () => {
    await expect(providersCmd(["modles", "openrouter"])).rejects.toThrow(
      'Unknown providers subcommand "modles"',
    );
  });

  it("throws when a bare provider id is given without the 'models' verb", async () => {
    await expect(providersCmd(["openrouter"])).rejects.toThrow(
      'Unknown providers subcommand "openrouter"',
    );
  });

  // Regression guard: trailing junk after the id must error, not be silently
  // ignored.
  it("throws on an extra trailing argument after the id", async () => {
    await expect(providersCmd(["models", "openrouter", "junk"])).rejects.toThrow(
      "unexpected extra argument(s): junk",
    );
  });
});
