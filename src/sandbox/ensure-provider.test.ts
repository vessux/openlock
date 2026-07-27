import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import {
  _ensureGenericProviderForTests,
  _ensureProviderForTests,
  _getProviderGatewayHealthForTests,
  credentialHealth,
  isWedgedRefreshCredential,
  parseProviderRefreshStatus,
  providerExistsInGateway,
} from "./ensure-provider";

let dir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openlock-ensure-"));
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

describe("providerExistsInGateway", () => {
  const tableStdout =
    "\x1b[1mNAME      \x1b[0m  \x1b[1mTYPE   \x1b[0m  \x1b[1mCREDENTIAL_KEYS\x1b[0m  \x1b[1mCONFIG_KEYS\x1b[0m\n" +
    "anthropic   claude-code  2                0\n" +
    "openrouter  generic      1                0\n";
  it("matches a row's first column against the provider id (ANSI-tolerant)", () => {
    expect(providerExistsInGateway(tableStdout, "openrouter")).toBe(true);
    expect(providerExistsInGateway(tableStdout, "anthropic")).toBe(true);
  });
  it("returns false when the name is absent", () => {
    const onlyAnthropic =
      "NAME      TYPE         CREDENTIAL_KEYS  CONFIG_KEYS\nanthropic claude-code  2                0\n";
    expect(providerExistsInGateway(onlyAnthropic, "openrouter")).toBe(false);
  });
  it("does not match substring-only collisions", () => {
    const tricky = "NAME    TYPE\nopenrouter-other  generic\n";
    expect(providerExistsInGateway(tricky, "openrouter")).toBe(false);
  });
});

interface MockState {
  existing: string[];
  profilePresent?: boolean;
}

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

// Flat fake-gateway responder (kept out of the closure to bound complexity).
// `provider profile import` is non-idempotent in the real gateway, so the probe
// (`profile export`) reports present/absent and `import` flips it to present.
function fakeGateway(args: string[], state: MockState) {
  const sub = `${args[1] ?? ""} ${args[2] ?? ""}`;
  if (args[1] === "list") {
    return ok(`NAME  TYPE\n${state.existing.map((n) => `${n}  generic`).join("\n")}\n`);
  }
  if (sub === "profile export") {
    return { exitCode: state.profilePresent ? 0 : 1, stdout: "", stderr: "" };
  }
  if (sub === "profile import") state.profilePresent = true;
  if (args[1] === "create") state.existing.push(args[args.indexOf("--name") + 1]);
  return ok();
}

describe("_ensureProviderForTests", () => {
  function makeShell(state: MockState) {
    const calls: string[][] = [];
    const envs: (Record<string, string> | undefined)[] = [];
    return {
      calls,
      envs,
      shell: async (args: string[], env?: Record<string, string>) => {
        calls.push(args);
        envs.push(env);
        return fakeGateway(args, state);
      },
    };
  }

  it("creates a new provider when absent", async () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-x" },
      created_at: "t",
    });
    const m = makeShell({ existing: [] });
    await _ensureProviderForTests("openrouter", m.shell);
    // First call is `provider list`, second is `provider create ...`
    expect(m.calls[1][1]).toBe("create");
    expect(m.calls[1]).toContain("--name");
    expect(m.calls[1]).toContain("openrouter");
    expect(m.calls[1]).toContain("--credential");
    // Credential passed as a bare KEY in argv; the value travels via env so it
    // never lands in /proc/<pid>/cmdline.
    expect(m.calls[1]).toContain("OPENROUTER_BEARER_TOKEN");
    expect(m.calls[1]).not.toContain("OPENROUTER_BEARER_TOKEN=Bearer sk-or-v1-x");
    expect(m.envs[1]?.OPENROUTER_BEARER_TOKEN).toBe("Bearer sk-or-v1-x");
  });

  it("updates an existing provider (no --type on update)", async () => {
    writeProvider("openrouter", {
      type: "openrouter",
      credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-y" },
      created_at: "t",
    });
    const m = makeShell({ existing: ["openrouter"] });
    await _ensureProviderForTests("openrouter", m.shell);
    expect(m.calls[1][1]).toBe("update");
    expect(m.calls[1]).not.toContain("--type");
  });

  it("throws when no credentials are stored", async () => {
    const m = makeShell({ existing: [] });
    await expect(_ensureProviderForTests("openrouter", m.shell)).rejects.toThrow(/No credentials/);
  });

  describe("anthropic OAuth refresh branch", () => {
    function writeAnthropic() {
      writeProvider("anthropic", {
        type: "claude-oauth",
        credentials: { ANTHROPIC_BEARER_TOKEN: "raw-access-token" },
        created_at: "t",
        refresh: {
          strategy: "oauth2_refresh_token",
          token_url: "https://platform.claude.com/v1/oauth/token",
          scopes: ["user:inference"],
          client_id: "client-abc",
          refresh_token: "rt-secret",
          access_expires_at: "2026-06-12T12:00:00Z",
        },
      });
    }

    function verb(calls: string[][], a: string, b: string): string[] | undefined {
      return calls.find((c) => c[0] === "provider" && c[1] === a && c[2] === b);
    }

    it("seeds once when absent: import, create, update, refresh-configure in order", async () => {
      writeAnthropic();
      const m = makeShell({ existing: [] });
      await _ensureProviderForTests("anthropic", m.shell);

      const imp = verb(m.calls, "profile", "import");
      const create = m.calls.find((c) => c[1] === "create");
      const update = m.calls.find((c) => c[1] === "update");
      const configure = verb(m.calls, "refresh", "configure");

      expect(imp).toBeDefined();
      expect(create).toBeDefined();
      expect(update).toBeDefined();
      expect(configure).toBeDefined();

      // ordering: import < create < update < configure
      const idx = (target: string[]) => m.calls.indexOf(target);
      expect(idx(imp as string[])).toBeLessThan(idx(create as string[]));
      expect(idx(create as string[])).toBeLessThan(idx(update as string[]));
      expect(idx(update as string[])).toBeLessThan(idx(configure as string[]));

      // create uses --type claude-oauth and the raw access token (passed via
      // env as a bare --credential KEY, not inline in argv).
      expect(create).toContain("--type");
      expect(create?.[create.indexOf("--type") + 1]).toBe("claude-oauth");
      expect(create).toContain("ANTHROPIC_BEARER_TOKEN");
      expect(create).not.toContain("ANTHROPIC_BEARER_TOKEN=raw-access-token");
      const createEnv = m.envs[m.calls.indexOf(create as string[])];
      expect(createEnv?.ANTHROPIC_BEARER_TOKEN).toBe("raw-access-token");

      // update seeds credential expiry
      expect(update).toContain("--credential-expires-at");
      expect(update).toContain("ANTHROPIC_BEARER_TOKEN=2026-06-12T12:00:00Z");

      // refresh configure: NAME is positional (not --name), kebab strategy,
      // client_id stays inline on --material (not secret), and its OWN
      // expires-at.
      expect(configure?.[3]).toBe("anthropic");
      expect(configure).not.toContain("--name");
      expect(configure).toContain("--strategy");
      expect(configure?.[configure.indexOf("--strategy") + 1]).toBe("oauth2-refresh-token");
      expect(configure).toContain("--material");
      expect(configure).toContain("client_id=client-abc");
      expect(configure).toContain("--credential-expires-at");
      expect(configure).toContain("2026-06-12T12:00:00Z");

      // The refresh token is secret and must NOT appear anywhere in argv —
      // neither inline (`refresh_token=rt-secret`) nor as a bare value — and
      // must NOT be marked via the now-redundant --secret-material-key (that
      // flag is dropped; --secret-material-env auto-marks the key secret on
      // the gateway side). It travels via --secret-material-env + env instead.
      expect(configure).not.toContain("--secret-material-key");
      expect(configure).not.toContain("refresh_token=rt-secret");
      for (const arg of configure ?? []) {
        expect(arg).not.toContain("rt-secret");
      }
      expect(configure).toContain("--secret-material-env");
      const envFlagValue = configure?.[(configure?.indexOf("--secret-material-env") ?? -1) + 1];
      expect(envFlagValue).toMatch(/^refresh_token=/);
      const envVarName = envFlagValue?.split("=")[1];
      expect(envVarName).toBeTruthy();
      const configureEnv = m.envs[m.calls.indexOf(configure as string[])];
      expect(configureEnv?.[envVarName as string]).toBe("rt-secret");
    });

    it("never clobbers when present: no create/update/refresh-configure", async () => {
      writeAnthropic();
      const m = makeShell({ existing: ["anthropic"], profilePresent: true });
      await _ensureProviderForTests("anthropic", m.shell);

      expect(m.calls.find((c) => c[1] === "create")).toBeUndefined();
      expect(m.calls.find((c) => c[1] === "update")).toBeUndefined();
      expect(verb(m.calls, "refresh", "configure")).toBeUndefined();
      // Profile already present → probed via export, NOT re-imported (import is
      // not idempotent — re-importing an existing id errors).
      expect(verb(m.calls, "profile", "export")).toBeDefined();
      expect(verb(m.calls, "profile", "import")).toBeUndefined();
    });

    it("re-seeds without re-importing when the profile already exists (provider deleted, profile lingering)", async () => {
      // Regression for the reattach/re-seed crash: a prior session left the
      // `claude-oauth` profile registered; deleting the provider and re-running
      // must seed create/update/configure WITHOUT re-importing the profile
      // (which would error "already exists").
      writeAnthropic();
      const m = makeShell({ existing: [], profilePresent: true });
      await _ensureProviderForTests("anthropic", m.shell);

      expect(verb(m.calls, "profile", "export")).toBeDefined();
      expect(verb(m.calls, "profile", "import")).toBeUndefined();
      expect(m.calls.find((c) => c[1] === "create")).toBeDefined();
      expect(m.calls.find((c) => c[1] === "update")).toBeDefined();
      expect(verb(m.calls, "refresh", "configure")).toBeDefined();
    });

    it("throws on the seed path when refresh material lacks ANTHROPIC_BEARER_TOKEN", async () => {
      writeProvider("anthropic", {
        type: "claude-oauth",
        credentials: {},
        created_at: "t",
        refresh: {
          strategy: "oauth2_refresh_token",
          token_url: "https://platform.claude.com/v1/oauth/token",
          scopes: ["user:inference"],
          client_id: "client-abc",
          refresh_token: "rt-secret",
          access_expires_at: "2026-06-12T12:00:00Z",
        },
      });
      const m = makeShell({ existing: [] });
      await expect(_ensureProviderForTests("anthropic", m.shell)).rejects.toThrow(
        /no ANTHROPIC_BEARER_TOKEN credential/,
      );
      // create must NOT have run with an undefined credential.
      expect(m.calls.find((c) => c[1] === "create")).toBeUndefined();
    });
  });
});

// openlock-7mh / openlock-stj: gateway credential health, the wedged-provider
// re-push predicate, and the hard preflight.
describe("gateway credential health", () => {
  const NOW = Date.parse("2026-07-27T12:00:00Z");

  function refreshStatusStdout(row: {
    provider: string;
    key: string;
    status: string;
    expiresAt: string; // "-" or "YYYY-MM-DD HH:MM:SS"
    lastError?: string;
  }): string {
    const header =
      "PROVIDER  CREDENTIAL_KEY  STRATEGY  STATUS  EXPIRES_AT  NEXT_REFRESH  LAST_REFRESH  LAST_ERROR";
    const data = [
      row.provider,
      row.key,
      "oauth2_refresh_token",
      row.status,
      row.expiresAt,
      "-",
      "-",
      row.lastError ?? "-",
    ].join("  ");
    return `${header}\n${data}\n`;
  }

  describe("credentialHealth", () => {
    it("is unknown with no expiry data at all", () => {
      expect(credentialHealth(["ANTHROPIC_BEARER_TOKEN"], {}, NOW)).toBe("unknown");
      expect(credentialHealth(["ANTHROPIC_BEARER_TOKEN"], null, NOW)).toBe("unknown");
    });
    it("is live when the tracked expiry is in the future", () => {
      expect(
        credentialHealth(["ANTHROPIC_BEARER_TOKEN"], { ANTHROPIC_BEARER_TOKEN: NOW + 1000 }, NOW),
      ).toBe("live");
    });
    it("is expired when the tracked expiry has passed", () => {
      expect(
        credentialHealth(["ANTHROPIC_BEARER_TOKEN"], { ANTHROPIC_BEARER_TOKEN: NOW - 1000 }, NOW),
      ).toBe("expired");
    });
  });

  describe("parseProviderRefreshStatus", () => {
    it("parses status/expiry/error from a real-shaped table", () => {
      const stdout = refreshStatusStdout({
        provider: "anthropic",
        key: "ANTHROPIC_BEARER_TOKEN",
        status: "error",
        expiresAt: "2026-06-19 20:30:00",
        lastError: "provider not found",
      });
      const parsed = parseProviderRefreshStatus(stdout);
      expect(parsed?.status).toBe("error");
      expect(parsed?.lastError).toBe("provider not found");
      expect(parsed?.expiresAtMs).toBe(Date.parse("2026-06-19T20:30:00Z"));
    });

    it("returns null for 'no refresh configuration' responses", () => {
      expect(
        parseProviderRefreshStatus(
          "No refresh configuration found for provider 'x' credential 'y'.\n",
        ),
      ).toBeNull();
    });

    it("returns null for empty output", () => {
      expect(parseProviderRefreshStatus("")).toBeNull();
    });
  });

  describe("isWedgedRefreshCredential", () => {
    it("is wedged when expired AND the refresh worker last errored", () => {
      expect(isWedgedRefreshCredential("expired", "error")).toBe(true);
    });
    it("is NOT wedged when expired but the refresh worker is healthy (still never-clobber)", () => {
      expect(isWedgedRefreshCredential("expired", "refreshed")).toBe(false);
    });
    it("is wedged when expired AND no refresh status could be established at all (the gap that used to loop forever)", () => {
      // Distinct from a "healthy" status — null means we couldn't even confirm
      // a refresh worker is tracking this key, so there is nothing for
      // never-clobber to protect.
      expect(isWedgedRefreshCredential("expired", null)).toBe(true);
    });
    it("is NOT wedged when the credential is still live, even if status is error", () => {
      expect(isWedgedRefreshCredential("live", "error")).toBe(false);
    });
    it("is NOT wedged when the credential is live and no refresh status is available", () => {
      expect(isWedgedRefreshCredential("live", null)).toBe(false);
    });
    it("is NOT wedged when credential health itself is unknown (can't even confirm it's expired)", () => {
      expect(isWedgedRefreshCredential("unknown", "error")).toBe(false);
      expect(isWedgedRefreshCredential("unknown", null)).toBe(false);
    });
  });

  describe("_ensureProviderForTests re-push on a wedged credential (openlock-stj)", () => {
    function writeAnthropic() {
      writeProvider("anthropic", {
        type: "claude-oauth",
        credentials: { ANTHROPIC_BEARER_TOKEN: "fresh-token-from-login" },
        created_at: "t",
        refresh: {
          strategy: "oauth2_refresh_token",
          token_url: "https://platform.claude.com/v1/oauth/token",
          scopes: ["user:inference"],
          client_id: "client-abc",
          refresh_token: "rt-fresh",
          access_expires_at: "2100-01-01T00:00:00Z",
        },
      });
    }

    // Stateful: `provider update --credential-expires-at KEY=TS` mutates the
    // expiry the subsequent `provider list --output json` reports, mirroring
    // what the real gateway does — so a test asserting "re-push happened" can
    // also confirm the preflight sees the FRESH state, not the pre-push one.
    function updatedExpiryMs(args: string[], current: number): number {
      if (args[0] !== "provider" || args[1] !== "update") return current;
      const flagIdx = args.indexOf("--credential-expires-at");
      if (flagIdx === -1) return current;
      const [, ts] = args[flagIdx + 1].split("=");
      return Date.parse(ts);
    }

    function wedgeShellResponse(
      args: string[],
      expiryMs: number,
      refreshStdout: string,
    ): { exitCode: number; stdout: string; stderr: string } {
      const cmd = args.slice(0, 4).join(" ");
      if (cmd.startsWith("provider list --output")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: "anthropic", credential_expires_at_ms: { ANTHROPIC_BEARER_TOKEN: expiryMs } },
          ]),
          stderr: "",
        };
      }
      if (cmd.startsWith("provider list")) {
        return { exitCode: 0, stdout: "NAME  TYPE\nanthropic  claude-oauth\n", stderr: "" };
      }
      if (cmd.startsWith("provider profile export")) {
        return { exitCode: 0, stdout: "", stderr: "" }; // profile already present
      }
      if (cmd.startsWith("provider refresh status")) {
        return { exitCode: 0, stdout: refreshStdout, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    function makeWedgeShell(refreshStdout: string, initialExpiryMs: number) {
      const calls: string[][] = [];
      let expiryMs = initialExpiryMs;
      const shell = async (args: string[]) => {
        calls.push(args);
        expiryMs = updatedExpiryMs(args, expiryMs);
        return wedgeShellResponse(args, expiryMs, refreshStdout);
      };
      return { calls, shell };
    }

    it("re-pushes fresh host credentials when wedged (expired + refresh error)", async () => {
      writeAnthropic();
      const refreshStdout = refreshStatusStdout({
        provider: "anthropic",
        key: "ANTHROPIC_BEARER_TOKEN",
        status: "error",
        expiresAt: "2026-06-19 20:30:00",
        lastError: "provider not found",
      });
      const { calls, shell } = makeWedgeShell(refreshStdout, Date.parse("2026-06-19T20:30:00Z"));
      await _ensureProviderForTests("anthropic", shell);

      expect(calls.find((c) => c[1] === "create")).toBeDefined();
      expect(calls.find((c) => c[1] === "refresh" && c[2] === "configure")).toBeDefined();
    });

    it("re-pushes when expired and no refresh status can be established at all (the gap that used to loop forever)", async () => {
      // Reachable today: `provider refresh configure` never successfully ran
      // for this key (e.g. an earlier push failed partway through), so the
      // gateway has no refresh status to report at all — a genuinely
      // different case from "the worker last errored", but equally beyond the
      // worker's own ability to repair. Before this fix,
      // isWedgedRefreshCredential(null, ...) was always false, so the credential
      // would stay expired forever: `openlock login` (which only ever touches
      // the LOCAL credentials.json) could never budge it, and every retry hit
      // the identical hard failure with the identical, un-actionable advice.
      writeAnthropic();
      const refreshStdout =
        "No refresh configuration found for provider 'anthropic' credential 'ANTHROPIC_BEARER_TOKEN'.\n";
      const { calls, shell } = makeWedgeShell(refreshStdout, Date.parse("2026-06-19T20:30:00Z"));
      await _ensureProviderForTests("anthropic", shell);

      expect(calls.find((c) => c[1] === "create")).toBeDefined();
      expect(calls.find((c) => c[1] === "refresh" && c[2] === "configure")).toBeDefined();
    });

    it("does NOT re-push when expired but the refresh worker is still healthy, and the preflight failure names the manual escape hatch", async () => {
      writeAnthropic();
      const refreshStdout = refreshStatusStdout({
        provider: "anthropic",
        key: "ANTHROPIC_BEARER_TOKEN",
        status: "refreshed",
        expiresAt: "2026-06-19 20:30:00",
      });
      const { calls, shell } = makeWedgeShell(refreshStdout, Date.parse("2026-06-19T20:30:00Z"));
      // Never-clobbered, so the gateway is left with its still-expired
      // credential -> the 7mh preflight (also under test here) must then
      // hard-fail rather than silently proceed. Because this record IS
      // refresh-capable and the self-heal path above already ran (and
      // correctly declined to push), plain `openlock login` advice alone is
      // not a promise this code can keep — the message must also carry the
      // proven manual recovery.
      await expect(_ensureProviderForTests("anthropic", shell)).rejects.toThrow(
        /no live credential/,
      );
      await expect(_ensureProviderForTests("anthropic", shell)).rejects.toThrow(
        /mise exec -- openshell provider delete anthropic/,
      );
      expect(calls.find((c) => c[1] === "create")).toBeUndefined();
      expect(calls.find((c) => c[1] === "refresh" && c[2] === "configure")).toBeUndefined();
    });

    it("does NOT re-push a live credential even if the refresh worker once errored", async () => {
      writeAnthropic();
      const refreshStdout = refreshStatusStdout({
        provider: "anthropic",
        key: "ANTHROPIC_BEARER_TOKEN",
        status: "error",
        expiresAt: "2100-01-01 00:00:00",
        lastError: "transient",
      });
      const { calls, shell } = makeWedgeShell(refreshStdout, Date.parse("2100-01-01T00:00:00Z"));
      await _ensureProviderForTests("anthropic", shell);
      expect(calls.find((c) => c[1] === "create")).toBeUndefined();
      expect(calls.find((c) => c[1] === "refresh" && c[2] === "configure")).toBeUndefined();
    });
  });

  describe("assertProviderHasLiveCredential preflight (openlock-7mh)", () => {
    function shellWithList(listJsonStdout: string) {
      return async (args: string[]) => {
        if (args[0] === "provider" && args[1] === "list" && args.includes("--output")) {
          return { exitCode: 0, stdout: listJsonStdout, stderr: "" };
        }
        if (args[0] === "provider" && args[1] === "list") {
          return { exitCode: 0, stdout: "NAME  TYPE\nanthropic  claude-oauth\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };
    }

    it("hard-fails naming the provider, the expiry, and the remediation command", async () => {
      writeProvider("anthropic", {
        type: "claude-oauth",
        credentials: { ANTHROPIC_BEARER_TOKEN: "stale-token" },
        created_at: "t",
      });
      const expiredMs = Date.parse("2026-06-19T20:30:00Z");
      const listJson = JSON.stringify([
        { name: "anthropic", credential_expires_at_ms: { ANTHROPIC_BEARER_TOKEN: expiredMs } },
      ]);
      const shell = shellWithList(listJson);
      await expect(_ensureProviderForTests("anthropic", shell)).rejects.toThrow(/anthropic/);
      await expect(_ensureProviderForTests("anthropic", shell)).rejects.toThrow(
        /openlock login --provider anthropic/,
      );
      // No `refresh` material stored -> there's no gateway-side self-heal path
      // to have failed, so the manual escape hatch (which only makes sense for
      // a refresh-capable provider) must NOT be advertised here.
      await expect(_ensureProviderForTests("anthropic", shell)).rejects.not.toThrow(/mise exec/);
    });

    it("passes when the gateway credential is live", async () => {
      writeProvider("anthropic", {
        type: "claude-oauth",
        credentials: { ANTHROPIC_BEARER_TOKEN: "live-token" },
        created_at: "t",
      });
      const liveMs = Date.parse("2100-01-01T00:00:00Z");
      const listJson = JSON.stringify([
        { name: "anthropic", credential_expires_at_ms: { ANTHROPIC_BEARER_TOKEN: liveMs } },
      ]);
      const shell = shellWithList(listJson);
      await expect(_ensureProviderForTests("anthropic", shell)).resolves.toBeUndefined();
    });
  });

  describe("_getProviderGatewayHealthForTests (openlock providers CLI)", () => {
    it("reports inGateway=false and unknown/null health when the provider is absent", async () => {
      const shell = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
      const health = await _getProviderGatewayHealthForTests("anthropic", shell);
      expect(health).toEqual({ inGateway: false, credential: "unknown", refresh: null });
    });

    it("reports live/expired credential health without a refresh column for a non-refresh-capable stored record", async () => {
      writeProvider("openrouter", {
        type: "openrouter",
        credentials: { OPENROUTER_BEARER_TOKEN: "Bearer sk-or-v1-x" },
        created_at: "t",
      });
      const shell = async (args: string[]) => {
        if (args.includes("--output")) {
          return { exitCode: 0, stdout: JSON.stringify([{ name: "openrouter" }]), stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const health = await _getProviderGatewayHealthForTests("openrouter", shell);
      // Present in the gateway, but no expiry ever tracked for a static key ->
      // "unknown" credential health (presence is all we know), and no refresh
      // material stored locally -> refresh stays null (not applicable).
      expect(health).toEqual({ inGateway: true, credential: "unknown", refresh: null });
    });

    it("surfaces a refresh-worker error for a refresh-capable provider", async () => {
      writeProvider("anthropic", {
        type: "claude-oauth",
        credentials: { ANTHROPIC_BEARER_TOKEN: "stale-token" },
        created_at: "t",
        refresh: {
          strategy: "oauth2_refresh_token",
          token_url: "https://platform.claude.com/v1/oauth/token",
          scopes: ["user:inference"],
          client_id: "client-abc",
          refresh_token: "rt-secret",
          access_expires_at: "2026-06-19T20:30:00Z",
        },
      });
      const expiredMs = Date.parse("2026-06-19T20:30:00Z");
      const refreshStatusTable =
        "PROVIDER  CREDENTIAL_KEY  STRATEGY  STATUS  EXPIRES_AT  NEXT_REFRESH  LAST_REFRESH  LAST_ERROR\n" +
        "anthropic  ANTHROPIC_BEARER_TOKEN  oauth2_refresh_token  error  2026-06-19 20:30:00  -  -  provider not found\n";
      const shell = async (args: string[]) => {
        if (args[0] === "provider" && args[1] === "list" && args.includes("--output")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                name: "anthropic",
                credential_expires_at_ms: { ANTHROPIC_BEARER_TOKEN: expiredMs },
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "provider" && args[1] === "refresh" && args[2] === "status") {
          return { exitCode: 0, stdout: refreshStatusTable, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const health = await _getProviderGatewayHealthForTests("anthropic", shell);
      expect(health).toEqual({ inGateway: true, credential: "expired", refresh: "error" });
    });
  });
});

describe("ensureGenericProvider", () => {
  function fakeShell(exists: boolean) {
    const calls: string[][] = [];
    const envs: (Record<string, string> | undefined)[] = [];
    const shell = async (args: string[], env?: Record<string, string>) => {
      calls.push(args);
      envs.push(env);
      if (args[0] === "provider" && args[1] === "list") {
        return {
          exitCode: 0,
          stdout: exists ? "NAME TYPE\ngithub generic 1 0\n" : "NAME TYPE\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { shell, calls, envs };
  }

  test("creates a generic provider when absent", async () => {
    const { shell, calls, envs } = fakeShell(false);
    await _ensureGenericProviderForTests("github", { GITHUB_TOKEN: "ghp_x" }, shell);
    const create = calls.find((c) => c[0] === "provider" && c[1] === "create");
    // Bare KEY in argv; secret value carried by env.
    expect(create).toEqual([
      "provider",
      "create",
      "--name",
      "github",
      "--type",
      "generic",
      "--credential",
      "GITHUB_TOKEN",
    ]);
    expect(envs[calls.indexOf(create as string[])]?.GITHUB_TOKEN).toBe("ghp_x");
  });

  test("updates when already present", async () => {
    const { shell, calls, envs } = fakeShell(true);
    await _ensureGenericProviderForTests("github", { GITHUB_TOKEN: "ghp_x" }, shell);
    const update = calls.find((c) => c[0] === "provider" && c[1] === "update");
    expect(update).toEqual(["provider", "update", "github", "--credential", "GITHUB_TOKEN"]);
    expect(envs[calls.indexOf(update as string[])]?.GITHUB_TOKEN).toBe("ghp_x");
    expect(calls.some((c) => c[1] === "create")).toBe(false);
  });

  test("error stderr does not include the credential value", async () => {
    const shell = async (args: string[]) => {
      if (args[1] === "list") return { exitCode: 0, stdout: "NAME\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "boom" };
    };
    await expect(
      _ensureGenericProviderForTests("github", { GITHUB_TOKEN: "ghp_SECRET" }, shell),
    ).rejects.toThrow(/github/);
    await expect(
      _ensureGenericProviderForTests("github", { GITHUB_TOKEN: "ghp_SECRET" }, shell),
    ).rejects.not.toThrow(/ghp_SECRET/);
  });
});
