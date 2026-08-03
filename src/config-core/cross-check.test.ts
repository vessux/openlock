import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { defaultPolicyContent } from "../sandbox/default-policies";
import { HARNESSES } from "../sandbox/harness";
import {
  checkCredentialNameCollisions,
  checkCredentialsSupplied,
  checkCredInjectValuePrefix,
  checkUninjectedCredentialHost,
} from "./cross-check";
import { scaffoldPolicy } from "./policy/scaffold";

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

describe("checkUninjectedCredentialHost", () => {
  test("warns when an endpoint allows a known provider credential host with no cred_inject (the shipped GH #79-class 401 footgun, verified live 2026-07-27)", () => {
    const policy = {
      network_policies: {
        claude_code: {
          endpoints: [
            { host: "platform.claude.com", rules: [{ allow: { method: "GET", path: "/**" } }] },
          ],
        },
      },
    };
    const issues = checkUninjectedCredentialHost(policy);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: "policy.yaml", severity: "warning" });
    expect(issues[0]?.message).toContain("platform.claude.com");
    expect(issues[0]?.message).toContain("claude_code");
  });

  test("warns when another endpoint in the same network_policy cred_injects the same host but this one doesn't", () => {
    const policy = {
      network_policies: {
        g: {
          endpoints: [
            {
              host: "api.example.com",
              cred_inject: { inject: [{ header: "Authorization", from_credential: "X_TOKEN" }] },
            },
            { host: "api.example.com", rules: [{ allow: { method: "GET", path: "/other" } }] },
          ],
        },
      },
    };
    const issues = checkUninjectedCredentialHost(policy);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toContain("endpoints[1]");
  });

  test("passes when the endpoint declares its own cred_inject", () => {
    const policy = {
      network_policies: {
        claude_code: {
          endpoints: [
            {
              host: "platform.claude.com",
              cred_inject: {
                inject: [{ header: "Authorization", from_credential: "ANTHROPIC_BEARER_TOKEN" }],
              },
            },
          ],
        },
      },
    };
    expect(checkUninjectedCredentialHost(policy)).toEqual([]);
  });

  test("passes for a host that is neither a known provider domain nor cred_injected elsewhere in the group", () => {
    const policy = {
      network_policies: {
        npm_packages: {
          endpoints: [
            { host: "registry.npmjs.org", rules: [{ allow: { method: "GET", path: "/**" } }] },
          ],
        },
      },
    };
    expect(checkUninjectedCredentialHost(policy)).toEqual([]);
  });

  test("returns [] when policy has no network_policies at all", () => {
    expect(checkUninjectedCredentialHost({})).toEqual([]);
  });

  test("the shipped default policy validates clean", () => {
    const defaultPolicyPath = join(import.meta.dir, "../../policies/default.yaml");
    const policy = yaml.load(readFileSync(defaultPolicyPath, "utf-8"));
    expect(
      checkUninjectedCredentialHost(policy as Parameters<typeof checkUninjectedCredentialHost>[0]),
    ).toEqual([]);
  });
});

describe("checkCredInjectValuePrefix", () => {
  const anthropicPolicy = (inject: Record<string, unknown>) => ({
    version: 1,
    network_policies: {
      claude_code: {
        endpoints: [{ host: "api.anthropic.com", cred_inject: { inject: [inject] } }],
      },
    },
  });

  test("errors when a provider-owned inject omits the required value_prefix", () => {
    // The exact field-report shape: a committed policy.yaml whose
    // api.anthropic.com inject lacks `value_prefix: 'Bearer '`. The anthropic
    // provider stores the OAuth token RAW, so the header ships as
    // `Authorization: sk-ant-oat01-...` and upstream answers 401.
    const issues = checkCredInjectValuePrefix(
      { credentials: [] },
      anthropicPolicy({ header: "Authorization", from_credential: "ANTHROPIC_BEARER_TOKEN" }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].file).toBe("policy.yaml");
    expect(issues[0].message).toContain("Bearer ");
    expect(issues[0].fix).toContain("value_prefix");
  });

  test("errors on a value_prefix the provider does not declare (double-prefix)", () => {
    // openrouter stores "Bearer " INLINE in the credential value, so adding a
    // value_prefix yields `Authorization: Bearer Bearer sk-or-...`.
    const policy = {
      version: 1,
      network_policies: {
        opencode: {
          endpoints: [
            {
              host: "openrouter.ai",
              cred_inject: {
                inject: [
                  {
                    header: "Authorization",
                    from_credential: "OPENROUTER_BEARER_TOKEN",
                    value_prefix: "Bearer ",
                  },
                ],
              },
            },
          ],
        },
      },
    };
    const issues = checkCredInjectValuePrefix({ credentials: [] }, policy);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  test("passes when the value_prefix matches the provider spec", () => {
    const issues = checkCredInjectValuePrefix(
      { credentials: [] },
      anthropicPolicy({
        header: "Authorization",
        from_credential: "ANTHROPIC_BEARER_TOKEN",
        value_prefix: "Bearer ",
      }),
    );
    expect(issues).toEqual([]);
  });

  test("matches the header case-insensitively (HTTP header names are)", () => {
    const issues = checkCredInjectValuePrefix(
      { credentials: [] },
      anthropicPolicy({ header: "authorization", from_credential: "ANTHROPIC_BEARER_TOKEN" }),
    );
    expect(issues).toHaveLength(1);
  });

  test("ignores a credential/host pair no provider owns", () => {
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
          ],
        },
      },
    };
    const issues = checkCredInjectValuePrefix(
      { credentials: [{ name: "gh", values: { GITHUB_TOKEN: { from_env: "GH" } } }] },
      policy,
    );
    expect(issues).toEqual([]);
  });

  test("warns instead of erroring when a declared bundle also supplies the credential", () => {
    // A bundle owns its own value shape (the user chooses whether to store the
    // prefix inline), so openlock cannot be certain the provider spec applies.
    const issues = checkCredInjectValuePrefix(
      {
        credentials: [
          { name: "myclaude", values: { ANTHROPIC_BEARER_TOKEN: { from_env: "TOK" } } },
        ],
      },
      anthropicPolicy({ header: "Authorization", from_credential: "ANTHROPIC_BEARER_TOKEN" }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
  });

  test("returns [] when policy has no network_policies at all", () => {
    expect(checkCredInjectValuePrefix({ credentials: [] }, {})).toEqual([]);
  });

  test("the shipped default policy validates clean", () => {
    const defaultPolicyPath = join(import.meta.dir, "../../policies/default.yaml");
    const policy = yaml.load(readFileSync(defaultPolicyPath, "utf-8"));
    expect(
      checkCredInjectValuePrefix(
        { credentials: [] },
        policy as Parameters<typeof checkCredInjectValuePrefix>[1],
      ),
    ).toEqual([]);
  });

  test("every harness's scaffolded policy.yaml validates clean", () => {
    // Guards the real `openlock init` output, not a hand-written fixture: the
    // scaffold is what lands in a user's repo and then drifts.
    for (const harness of HARNESSES) {
      const scaffolded = yaml.load(scaffoldPolicy(harness, defaultPolicyContent()));
      expect(
        checkCredInjectValuePrefix(
          { credentials: [] },
          scaffolded as Parameters<typeof checkCredInjectValuePrefix>[1],
        ),
      ).toEqual([]);
    }
  });
});
