import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  claudeKeychainService,
  type ImportDeps,
  importFromClaudeCode,
  parseClaudeOauthBlob,
} from "./anthropic-import";
import type { LoginIO } from "./types";

describe("parseClaudeOauthBlob", () => {
  const valid = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-realish",
      refreshToken: "sk-ant-ort01-realish",
      expiresAt: 1893456000000, // 2030-01-01, deterministic
      scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
      subscriptionType: "max",
    },
  });

  it("maps the claudeAiOauth blob to a LoginResult with raw access token", () => {
    const r = parseClaudeOauthBlob(valid);
    expect(r.credentials).toEqual({ ANTHROPIC_BEARER_TOKEN: "sk-ant-oat01-realish" });
    expect(r.refresh?.strategy).toBe("oauth2_refresh_token");
    expect(r.refresh?.token_url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(r.refresh?.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(r.refresh?.refresh_token).toBe("sk-ant-ort01-realish");
    expect(r.refresh?.scopes).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
    ]);
    expect(r.refresh?.access_expires_at).toBe(new Date(1893456000000).toISOString());
  });

  it("accepts a bare blob without the claudeAiOauth wrapper", () => {
    const bare = JSON.stringify({ accessToken: "a", refreshToken: "b", expiresAt: 1893456000000 });
    expect(parseClaudeOauthBlob(bare).credentials.ANTHROPIC_BEARER_TOKEN).toBe("a");
  });

  it("throws on non-JSON input", () => {
    expect(() => parseClaudeOauthBlob("not json")).toThrow(/not valid JSON/);
  });

  it("throws when accessToken or refreshToken is missing", () => {
    const noRefresh = JSON.stringify({ claudeAiOauth: { accessToken: "a" } });
    expect(() => parseClaudeOauthBlob(noRefresh)).toThrow(/accessToken\/refreshToken/);
  });

  it("falls back to a ~1h future expiry when expiresAt is absent/non-numeric", () => {
    const noExp = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b" } });
    const r = parseClaudeOauthBlob(noExp);
    expect(new Date(r.refresh!.access_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("defaults scopes when absent", () => {
    const noScopes = JSON.stringify({
      claudeAiOauth: { accessToken: "a", refreshToken: "b", expiresAt: 1893456000000 },
    });
    expect(parseClaudeOauthBlob(noScopes).refresh?.scopes).toEqual([
      "user:profile",
      "user:inference",
    ]);
  });
});

describe("claudeKeychainService", () => {
  it("matches CC's derivation: Claude Code-credentials-<sha256(NFC dir)[:8]>", () => {
    const dir = "/tmp/openlock-cc-login-abc123";
    const want = `Claude Code-credentials-${createHash("sha256")
      .update(dir.normalize("NFC"))
      .digest("hex")
      .slice(0, 8)}`;
    expect(claudeKeychainService(dir)).toBe(want);
  });

  it("NFC-normalizes the dir before hashing", () => {
    // Precomposed e-acute (U+00E9) vs decomposed e + combining acute (U+0065 U+0301):
    // distinct byte sequences sharing one NFC form -> identical service name.
    // Built with fromCodePoint so the source stays pure-ASCII (no literal accents).
    const precomposed = `/tmp/caf${String.fromCodePoint(0x00e9)}`;
    const decomposed = `/tmp/cafe${String.fromCodePoint(0x0301)}`;
    expect(precomposed).not.toBe(decomposed); // genuinely different inputs
    expect(claudeKeychainService(precomposed)).toBe(claudeKeychainService(decomposed));
  });
});

function silentIO(): LoginIO {
  return {
    isTTY: true,
    writeStdout() {},
    writeStderr() {},
    async readLine() {
      return "";
    },
  };
}

const BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: "AT", refreshToken: "RT", expiresAt: 1893456000000 },
});

function baseDeps(over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    platform: "linux",
    hasClaude: () => true,
    makeConfigDir: () => "/tmp/cfgX",
    spawnLogin: async () => 0,
    readFile: () => BLOB,
    readKeychain: () => BLOB,
    deleteKeychain: () => {},
    removeDir: () => {},
    ...over,
  };
}

describe("importFromClaudeCode", () => {
  it("on Linux reads .credentials.json from the throwaway dir", async () => {
    let readPath = "";
    const deps = baseDeps({
      readFile: (p) => {
        readPath = p;
        return BLOB;
      },
    });
    const r = await importFromClaudeCode(silentIO(), deps);
    expect(r.credentials.ANTHROPIC_BEARER_TOKEN).toBe("AT");
    expect(readPath).toBe("/tmp/cfgX/.credentials.json");
  });

  it("on macOS reads the computed keychain item and deletes it after", async () => {
    let readService = "";
    let deletedService = "";
    const deps = baseDeps({
      platform: "darwin",
      makeConfigDir: () => "/tmp/cfgMac",
      readKeychain: (s) => {
        readService = s;
        return BLOB;
      },
      deleteKeychain: (s) => {
        deletedService = s;
      },
    });
    const r = await importFromClaudeCode(silentIO(), deps);
    expect(r.credentials.ANTHROPIC_BEARER_TOKEN).toBe("AT");
    expect(readService).toBe(claudeKeychainService("/tmp/cfgMac"));
    expect(deletedService).toBe(claudeKeychainService("/tmp/cfgMac"));
  });

  it("throws an actionable error when claude is not on PATH", async () => {
    await expect(importFromClaudeCode(silentIO(), baseDeps({ hasClaude: () => false }))).rejects.toThrow(
      /not found on PATH/,
    );
  });

  it("throws when the login subprocess exits non-zero", async () => {
    await expect(
      importFromClaudeCode(silentIO(), baseDeps({ spawnLogin: async () => 1 })),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("throws when no credential was stored", async () => {
    await expect(
      importFromClaudeCode(silentIO(), baseDeps({ readFile: () => null })),
    ).rejects.toThrow(/Could not read/);
  });

  it("always removes the throwaway dir, even on harvest failure", async () => {
    let removed = false;
    const deps = baseDeps({
      readFile: () => null,
      removeDir: () => {
        removed = true;
      },
    });
    await expect(importFromClaudeCode(silentIO(), deps)).rejects.toThrow();
    expect(removed).toBe(true);
  });
});
