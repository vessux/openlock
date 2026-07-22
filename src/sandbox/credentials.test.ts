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
    expect(() => resolveCredentialValues(bundle, { GH_PAT: "ghp_x", EXTRA_VAR: "" })).toThrow(/EXTRA_VAR/);
  });
});
