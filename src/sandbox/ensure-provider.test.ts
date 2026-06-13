import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProvider } from "../tokens";
import { _ensureProviderForTests, providerExistsInGateway } from "./ensure-provider";

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

describe("_ensureProviderForTests", () => {
  function makeShell(state: { existing: string[]; profilePresent?: boolean }) {
    const calls: string[][] = [];
    return {
      calls,
      shell: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "provider" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: `NAME  TYPE\n${state.existing.map((n) => `${n}  generic`).join("\n")}\n`,
            stderr: "",
          };
        }
        // profile export: existence probe (exit 0 = present, nonzero = absent).
        if (args[1] === "profile" && args[2] === "export") {
          return { exitCode: state.profilePresent ? 0 : 1, stdout: "", stderr: "" };
        }
        // profile import registers the profile (mirrors the gateway's behavior:
        // a SECOND import of the same id would error, so we only get here when absent).
        if (args[1] === "profile" && args[2] === "import") state.profilePresent = true;
        // create / update: pretend success and mutate state for create
        if (args[1] === "create") state.existing.push(args[args.indexOf("--name") + 1]);
        return { exitCode: 0, stdout: "", stderr: "" };
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
    expect(m.calls[1]).toContain("OPENROUTER_BEARER_TOKEN=Bearer sk-or-v1-x");
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

      // create uses --type claude-oauth and the raw access token
      expect(create).toContain("--type");
      expect(create?.[create.indexOf("--type") + 1]).toBe("claude-oauth");
      expect(create).toContain("ANTHROPIC_BEARER_TOKEN=raw-access-token");

      // update seeds credential expiry
      expect(update).toContain("--credential-expires-at");
      expect(update).toContain("ANTHROPIC_BEARER_TOKEN=2026-06-12T12:00:00Z");

      // refresh configure: NAME is positional (not --name), kebab strategy,
      // material values, secret-material-key, and its OWN expires-at.
      expect(configure?.[3]).toBe("anthropic");
      expect(configure).not.toContain("--name");
      expect(configure).toContain("--strategy");
      expect(configure?.[configure.indexOf("--strategy") + 1]).toBe("oauth2-refresh-token");
      expect(configure).toContain("--material");
      expect(configure).toContain("client_id=client-abc");
      expect(configure).toContain("refresh_token=rt-secret");
      expect(configure).toContain("--secret-material-key");
      expect(configure?.[configure.indexOf("--secret-material-key") + 1]).toBe("refresh_token");
      expect(configure).toContain("--credential-expires-at");
      expect(configure).toContain("2026-06-12T12:00:00Z");
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
