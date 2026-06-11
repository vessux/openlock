import { describe, expect, test } from "bun:test";
import { validateSchema } from "./schema";

describe("validateSchema", () => {
  test("accepts minimal valid policy", () => {
    const errors = validateSchema({ version: 1 });
    expect(errors).toHaveLength(0);
  });

  test("accepts full valid policy", () => {
    const errors = validateSchema({
      version: 1,
      filesystem_policy: {
        include_workdir: true,
        read_only: ["/usr", "/lib"],
        read_write: ["/tmp"],
      },
      landlock: { compatibility: "best_effort" },
      process: { run_as_user: "sandbox", run_as_group: "sandbox" },
      network_policies: {
        claude: {
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [
            {
              host: "api.anthropic.com",
              port: 443,
              protocol: "rest",
              enforcement: "enforce",
              rules: [{ allow: { method: "POST", path: "/v1/**" } }],
              cred_inject: {
                provider: "anthropic",
                strip_headers: ["Authorization"],
                inject: [{ header: "x-api-key", from_credential: "ANTHROPIC_API_KEY" }],
              },
              echo: false,
            },
          ],
          allowed_secrets: ["ANTHROPIC_API_KEY"],
        },
      },
    });
    expect(errors).toHaveLength(0);
  });

  test("accepts an endpoint with no cred_inject (pure allow-egress)", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        opencode: {
          endpoints: [
            {
              host: "models.dev",
              port: 443,
              protocol: "rest",
              enforcement: "enforce",
              rules: [{ allow: { method: "GET", path: "/**" } }],
            },
          ],
          allowed_secrets: [],
        },
      },
    });
    expect(errors).toHaveLength(0);
  });

  test("rejects missing version", () => {
    const errors = validateSchema({});
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("version");
    expect(errors[0].message).toContain("missing");
  });

  test("rejects unknown top-level field", () => {
    const errors = validateSchema({ version: 1, bogus: true });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("bogus");
  });

  test("rejects unknown endpoint field", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [{ host: "example.com", port: 443, magic: true }],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("magic"))).toBe(true);
  });

  test("rejects invalid port", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [{ host: "example.com", port: 99999 }],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("1-65535"))).toBe(true);
  });

  test("rejects string port", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [{ host: "example.com", port: "443" }],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("integer"))).toBe(true);
  });

  test("rejects non-object top level", () => {
    const errors = validateSchema("hello");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("expected object");
  });

  test("rejects missing host on endpoint", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: { endpoints: [{ port: 443 }] },
      },
    });
    expect(errors.some((e) => e.message.includes("host"))).toBe(true);
  });

  test("rejects missing allow in rule", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [{ host: "x.com", rules: [{}] }],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("allow"))).toBe(true);
  });

  test("rejects unknown field in cred_inject", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [
            {
              host: "x.com",
              cred_inject: { provider: "a", nope: true },
            },
          ],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("nope"))).toBe(true);
  });

  test("rejects missing required fields in cred_inject header", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [
            {
              host: "x.com",
              cred_inject: { inject: [{ header: "x-api-key" }] },
            },
          ],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("from_credential"))).toBe(true);
  });

  test("accepts query matcher as string glob", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [
            {
              host: "x.com",
              rules: [{ allow: { method: "GET", query: { model: "claude-*" } } }],
            },
          ],
        },
      },
    });
    expect(errors).toHaveLength(0);
  });

  test("accepts query matcher as any-of object", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [
            {
              host: "x.com",
              rules: [{ allow: { method: "GET", query: { model: { any: ["a", "b"] } } } }],
            },
          ],
        },
      },
    });
    expect(errors).toHaveLength(0);
  });

  test("rejects deny_rules with unknown field", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [{ host: "x.com", deny_rules: [{ method: "DELETE", oops: true }] }],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("oops"))).toBe(true);
  });

  test("accepts binary with deprecated harness field", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: { binaries: [{ path: "/usr/bin/node", harness: true }] },
      },
    });
    expect(errors).toHaveLength(0);
  });

  test("rejects unknown binary field", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: { binaries: [{ path: "/usr/bin/node", foo: "bar" }] },
      },
    });
    expect(errors.some((e) => e.message.includes("foo"))).toBe(true);
  });

  test("accepts ports array", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: { endpoints: [{ host: "x.com", ports: [80, 443] }] },
      },
    });
    expect(errors).toHaveLength(0);
  });

  test("rejects invalid port in ports array", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: { endpoints: [{ host: "x.com", ports: [80, 70000] }] },
      },
    });
    expect(errors.some((e) => e.message.includes("1-65535"))).toBe(true);
  });

  test("accepts trust_check with valid registry", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [{ host: "pypi.org", port: 443, trust_check: { registry: "pypi" } }],
        },
      },
    });
    expect(errors).toHaveLength(0);
  });

  test("rejects trust_check with unknown field", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [
            { host: "pypi.org", port: 443, trust_check: { registry: "pypi", extra: true } },
          ],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("extra"))).toBe(true);
  });

  test("rejects trust_check missing registry", () => {
    const errors = validateSchema({
      version: 1,
      network_policies: {
        test: {
          endpoints: [{ host: "pypi.org", port: 443, trust_check: {} }],
        },
      },
    });
    expect(errors.some((e) => e.message.includes("registry"))).toBe(true);
  });
});
