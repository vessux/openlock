import { describe, expect, test } from "bun:test";
import { checkCredentialNameCollisions, checkCredentialsSupplied } from "./cross-check";

const policyInjecting = (cred: string) => ({
  version: 1,
  network_policies: {
    g: {
      endpoints: [
        {
          host: "api.github.com",
          cred_inject: { inject: [{ header: "Authorization", from_credential: cred }] },
        },
      ],
    },
  },
});

describe("checkCredentialsSupplied", () => {
  test("errors when injected credential is supplied by nothing", () => {
    const issues = checkCredentialsSupplied({ credentials: [] }, policyInjecting("GITHUB_TOKEN"));
    expect(issues.some((i) => i.message.includes("GITHUB_TOKEN"))).toBe(true);
    expect(issues.every((i) => i.severity === "error" && i.file === "policy.yaml")).toBe(true);
  });

  test("passes when supplied by a declared bundle", () => {
    const issues = checkCredentialsSupplied(
      { credentials: [{ name: "github", values: { GITHUB_TOKEN: { from_env: "X" } } }] },
      policyInjecting("GITHUB_TOKEN"),
    );
    expect(issues).toEqual([]);
  });

  test("passes when supplied by a known primary provider credential", () => {
    // ANTHROPIC_BEARER_TOKEN is the real credentialEnvVars entry in
    // src/providers/anthropic.ts (registry-derived, not ANTHROPIC_API_KEY).
    const issues = checkCredentialsSupplied(
      { credentials: [] },
      policyInjecting("ANTHROPIC_BEARER_TOKEN"),
    );
    expect(issues).toEqual([]);
  });

  test("passes when supplied by another known primary provider credential (openrouter)", () => {
    const issues = checkCredentialsSupplied(
      { credentials: [] },
      policyInjecting("OPENROUTER_BEARER_TOKEN"),
    );
    expect(issues).toEqual([]);
  });

  test("de-duplicates the same missing credential injected across multiple endpoints", () => {
    const policy = {
      version: 1,
      network_policies: {
        a: {
          endpoints: [
            {
              host: "one.example.com",
              cred_inject: { inject: [{ header: "Authorization", from_credential: "MISSING" }] },
            },
          ],
        },
        b: {
          endpoints: [
            {
              host: "two.example.com",
              cred_inject: { inject: [{ header: "Authorization", from_credential: "MISSING" }] },
            },
          ],
        },
      },
    };
    const issues = checkCredentialsSupplied({ credentials: [] }, policy);
    expect(issues).toHaveLength(1);
  });

  test("handles multiple endpoints in one network_policy group, only flagging the unsupplied one", () => {
    const policy = {
      version: 1,
      network_policies: {
        g: {
          endpoints: [
            {
              host: "api.github.com",
              cred_inject: {
                inject: [{ header: "Authorization", from_credential: "GITHUB_TOKEN" }],
              },
            },
            {
              host: "api.anthropic.com",
              cred_inject: {
                inject: [{ header: "Authorization", from_credential: "ANTHROPIC_BEARER_TOKEN" }],
              },
            },
          ],
        },
      },
    };
    const issues = checkCredentialsSupplied({ credentials: [] }, policy);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("GITHUB_TOKEN");
  });

  test("returns [] when policy has no network_policies at all", () => {
    expect(checkCredentialsSupplied({ credentials: [] }, {})).toEqual([]);
  });
});

describe("checkCredentialNameCollisions", () => {
  test("errors when a bundle name collides with a registered provider id", () => {
    const issues = checkCredentialNameCollisions({
      credentials: [{ name: "anthropic", values: { X: { from_env: "X" } } }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "config.yaml",
      severity: "error",
      path: "credentials[0].name",
    });
    expect(issues[0]?.message).toContain("anthropic");
  });

  test("passes for a normally-named bundle", () => {
    const issues = checkCredentialNameCollisions({
      credentials: [{ name: "github", values: { GITHUB_TOKEN: { from_env: "GITHUB_TOKEN" } } }],
    });
    expect(issues).toEqual([]);
  });
});
