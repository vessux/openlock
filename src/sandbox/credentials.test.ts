import { describe, expect, test } from "bun:test";
import type { CredentialBundle } from "../config-core";
import { resolveCredentialValues } from "./credentials";

const bundle: CredentialBundle = {
  name: "github",
  values: { GITHUB_TOKEN: { from_env: "GH_PAT" }, EXTRA: { from_env: "EXTRA_VAR" } },
};

describe("resolveCredentialValues", () => {
  test("resolves each from_env from the provided env", () => {
    const out = resolveCredentialValues(bundle, { GH_PAT: "ghp_x", EXTRA_VAR: "e" });
    expect(out).toEqual({ GITHUB_TOKEN: "ghp_x", EXTRA: "e" });
  });

  test("throws naming the bundle + missing var when unset", () => {
    expect(() => resolveCredentialValues(bundle, { GH_PAT: "ghp_x" })).toThrow(/github.*EXTRA_VAR/);
  });

  test("throws when a var is set but empty", () => {
    expect(() => resolveCredentialValues(bundle, { GH_PAT: "ghp_x", EXTRA_VAR: "" })).toThrow(
      /EXTRA_VAR/,
    );
  });
});

describe("resolveCredentialValues with literal sources", () => {
  test("returns a literal value verbatim, untrimmed, without consulting env", () => {
    const literalBundle: CredentialBundle = {
      name: "anthropic-meta",
      values: {
        ANTHROPIC_BETA: { literal: "oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14" },
        SPACED: { literal: " padded value " },
      },
    };
    const out = resolveCredentialValues(literalBundle, {});
    expect(out).toEqual({
      ANTHROPIC_BETA: "oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
      SPACED: " padded value ",
    });
  });

  test("a bundle mixing from_env and literal sources resolves both correctly", () => {
    const mixedBundle: CredentialBundle = {
      name: "mixed",
      values: {
        GITHUB_TOKEN: { from_env: "GH_PAT" },
        ANTHROPIC_BETA: { literal: "code-execution-2025-01-01" },
      },
    };
    const out = resolveCredentialValues(mixedBundle, { GH_PAT: "ghp_x" });
    expect(out).toEqual({
      GITHUB_TOKEN: "ghp_x",
      ANTHROPIC_BETA: "code-execution-2025-01-01",
    });
  });

  test("mixed bundle still hard-errors on an unset from_env var, unaffected by the literal entry", () => {
    const mixedBundle: CredentialBundle = {
      name: "mixed",
      values: {
        GITHUB_TOKEN: { from_env: "GH_PAT" },
        ANTHROPIC_BETA: { literal: "code-execution-2025-01-01" },
      },
    };
    expect(() => resolveCredentialValues(mixedBundle, {})).toThrow(/mixed.*GH_PAT/);
  });
});
