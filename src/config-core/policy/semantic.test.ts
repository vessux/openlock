import { describe, expect, test } from "bun:test";
import { validateSemantics } from "./semantic";
import type { PolicyFile } from "./types";

function minimal(overrides?: Partial<PolicyFile>): PolicyFile {
  return { version: 1, ...overrides };
}

describe("validateSemantics", () => {
  test("accepts valid policy", () => {
    const errors = validateSemantics(
      minimal({
        process: { run_as_user: "sandbox", run_as_group: "sandbox" },
        filesystem_policy: {
          read_only: ["/usr"],
          read_write: ["/tmp"],
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  test("rejects non-sandbox run_as_user", () => {
    const errors = validateSemantics(
      minimal({ process: { run_as_user: "root", run_as_group: "sandbox" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("process.run_as_user");
    expect(errors[0].message).toContain("sandbox");
  });

  test("rejects non-sandbox run_as_group", () => {
    const errors = validateSemantics(
      minimal({ process: { run_as_user: "sandbox", run_as_group: "wheel" } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("process.run_as_group");
  });

  test("rejects relative filesystem path", () => {
    const errors = validateSemantics(
      minimal({ filesystem_policy: { read_only: ["relative/path"] } }),
    );
    expect(errors.some((e) => e.message.includes("relative"))).toBe(true);
  });

  test("rejects path traversal", () => {
    const errors = validateSemantics(
      minimal({ filesystem_policy: { read_only: ["/usr/../etc/shadow"] } }),
    );
    expect(errors.some((e) => e.message.includes("traversal"))).toBe(true);
  });

  test("rejects root as read-write", () => {
    const errors = validateSemantics(minimal({ filesystem_policy: { read_write: ["/"] } }));
    expect(errors.some((e) => e.message.includes("overly broad"))).toBe(true);
  });

  test("rejects root variants (trailing slashes)", () => {
    const errors = validateSemantics(minimal({ filesystem_policy: { read_write: ["///"] } }));
    expect(errors.some((e) => e.message.includes("overly broad"))).toBe(true);
  });

  test("rejects too many filesystem paths", () => {
    const paths = Array.from({ length: 257 }, (_, i) => `/path${i}`);
    const errors = validateSemantics(minimal({ filesystem_policy: { read_only: paths } }));
    expect(errors.some((e) => e.message.includes("too many"))).toBe(true);
  });

  test("rejects TLD wildcard host", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          test: {
            endpoints: [{ host: "*.com", port: 443 }],
          },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes("TLD wildcard"))).toBe(true);
  });

  test("accepts deeper wildcard host", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          test: {
            endpoints: [{ host: "*.api.example.com", port: 443 }],
          },
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  test("warns when cred_inject credential not in allowed_secrets", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          test: {
            endpoints: [
              {
                host: "api.anthropic.com",
                port: 443,
                cred_inject: {
                  provider: "anthropic",
                  inject: [{ header: "x-api-key", from_credential: "ANTHROPIC_API_KEY" }],
                },
              },
            ],
            allowed_secrets: ["OTHER_KEY"],
          },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes("ANTHROPIC_API_KEY"))).toBe(true);
    expect(errors.some((e) => e.message.includes("allowed_secrets"))).toBe(true);
  });

  test("passes when cred_inject credential is in allowed_secrets", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          test: {
            endpoints: [
              {
                host: "api.anthropic.com",
                port: 443,
                cred_inject: {
                  provider: "anthropic",
                  inject: [{ header: "x-api-key", from_credential: "ANTHROPIC_API_KEY" }],
                },
              },
            ],
            allowed_secrets: ["ANTHROPIC_API_KEY"],
          },
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  test("skips cred check when allowed_secrets is empty", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          test: {
            endpoints: [
              {
                host: "api.anthropic.com",
                port: 443,
                cred_inject: {
                  provider: "anthropic",
                  inject: [{ header: "x-api-key", from_credential: "ANTHROPIC_API_KEY" }],
                },
              },
            ],
          },
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  test("accepts an endpoint with no cred_inject (pure allow-egress)", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          opencode: {
            endpoints: [
              {
                host: "models.dev",
                port: 443,
                rules: [{ allow: { method: "GET", path: "/**" } }],
              },
            ],
            // non-empty allowed_secrets must not make a cred-less endpoint fail
            allowed_secrets: ["OPENROUTER_BEARER_TOKEN"],
          },
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  test("rejects unknown trust_check registry", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          test: {
            endpoints: [{ host: "example.com", port: 443, trust_check: { registry: "maven" } }],
          },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes("maven"))).toBe(true);
  });

  test("accepts valid trust_check registries", () => {
    const errors = validateSemantics(
      minimal({
        network_policies: {
          pip: {
            endpoints: [{ host: "pypi.org", port: 443, trust_check: { registry: "pypi" } }],
          },
          npm: {
            endpoints: [
              { host: "registry.npmjs.org", port: 443, trust_check: { registry: "npm" } },
            ],
          },
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });
});
