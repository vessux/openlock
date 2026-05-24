import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  deleteProvider,
  readCredentials,
  readProvider,
  readToken,
  writeProvider,
  writeToken,
} from "./tokens";

let dir: string;
let path: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  dir = mkdtempSync(join(tmpdir(), "openlock-tokens-"));
  path = join(dir, "credentials.json");
  process.env.HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("credentialsPath", () => {
  it("uses HOME/.config/openlock/credentials.json", () => {
    expect(credentialsPath()).toBe(join(dir, ".config", "openlock", "credentials.json"));
  });
});

describe("readCredentials on missing file", () => {
  it("returns an empty v2 stub", () => {
    const c = readCredentials(path);
    expect(c).toEqual({ version: 2, providers: {} });
  });
});

describe("writeProvider/readProvider roundtrip", () => {
  it("persists a provider record at mode 0600", () => {
    writeProvider(
      "openrouter",
      {
        type: "openrouter",
        credentials: { OPENROUTER_API_KEY: "sk-or-v1-test" },
        created_at: "2026-05-24T00:00:00.000Z",
      },
      path,
    );
    expect(readProvider("openrouter", path)).toEqual({
      type: "openrouter",
      credentials: { OPENROUTER_API_KEY: "sk-or-v1-test" },
      created_at: "2026-05-24T00:00:00.000Z",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("returns null when provider is absent", () => {
    expect(readProvider("openrouter", path)).toBeNull();
  });

  it("does not clobber sibling providers", () => {
    writeProvider(
      "anthropic",
      {
        type: "claude",
        credentials: { ANTHROPIC_AUTH_TOKEN: "abc" },
        created_at: "2026-05-24T00:00:00.000Z",
      },
      path,
    );
    writeProvider(
      "openrouter",
      {
        type: "openrouter",
        credentials: { OPENROUTER_API_KEY: "sk-or-v1-x" },
        created_at: "2026-05-24T00:00:01.000Z",
      },
      path,
    );
    expect(readProvider("anthropic", path)?.credentials.ANTHROPIC_AUTH_TOKEN).toBe("abc");
    expect(readProvider("openrouter", path)?.credentials.OPENROUTER_API_KEY).toBe("sk-or-v1-x");
  });
});

describe("deleteProvider", () => {
  it("removes one entry and leaves others intact", () => {
    writeProvider(
      "anthropic",
      { type: "claude", credentials: { ANTHROPIC_AUTH_TOKEN: "x" }, created_at: "t1" },
      path,
    );
    writeProvider(
      "openrouter",
      { type: "openrouter", credentials: { OPENROUTER_API_KEY: "sk-or-v1-x" }, created_at: "t2" },
      path,
    );
    deleteProvider("openrouter", path);
    expect(readProvider("openrouter", path)).toBeNull();
    expect(readProvider("anthropic", path)).not.toBeNull();
  });
});

describe("v1 -> v2 migration", () => {
  it("converts legacy {token,created_at} into providers.anthropic", () => {
    writeFileSync(
      path,
      JSON.stringify({ token: "legacy-token", created_at: "2026-04-01T00:00:00.000Z" }),
      { mode: 0o600 },
    );
    const file = readCredentials(path);
    expect(file.version).toBe(2);
    expect(file.providers.anthropic).toEqual({
      type: "claude",
      credentials: {
        ANTHROPIC_BEARER_TOKEN: "Bearer legacy-token",
        ANTHROPIC_AUTH_TOKEN: "legacy-token",
      },
      created_at: "2026-04-01T00:00:00.000Z",
    });
    // and the new shape is now on disk:
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.version).toBe(2);
  });

  it("is idempotent", () => {
    writeFileSync(
      path,
      JSON.stringify({ token: "legacy-token", created_at: "2026-04-01T00:00:00.000Z" }),
      { mode: 0o600 },
    );
    readCredentials(path);
    const before = readFileSync(path, "utf-8");
    readCredentials(path);
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before);
  });
});

describe("readToken shim (legacy callers)", () => {
  it("returns ANTHROPIC_AUTH_TOKEN value when anthropic is stored", () => {
    writeProvider(
      "anthropic",
      {
        type: "claude",
        credentials: {
          ANTHROPIC_BEARER_TOKEN: "Bearer x",
          ANTHROPIC_AUTH_TOKEN: "x",
        },
        created_at: "t",
      },
      path,
    );
    expect(readToken(path)).toBe("x");
  });
  it("returns null when no anthropic record", () => {
    expect(readToken(path)).toBeNull();
  });
});

describe("writeToken shim (legacy callers)", () => {
  it("delegates to writeProvider('anthropic', ...)", () => {
    writeToken(path, "tok123");
    const r = readProvider("anthropic", path);
    expect(r?.credentials.ANTHROPIC_AUTH_TOKEN).toBe("tok123");
    expect(r?.credentials.ANTHROPIC_BEARER_TOKEN).toBe("Bearer tok123");
  });
});

describe("malformed file", () => {
  it("returns empty v2 stub on invalid JSON", () => {
    writeFileSync(path, "{not-json", { mode: 0o600 });
    expect(readCredentials(path)).toEqual({ version: 2, providers: {} });
  });
});
