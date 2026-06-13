import { describe, expect, it } from "bun:test";
import type { LoginIO, PolicyEndpointSpec, ProviderCredentials, ProviderPlugin } from "./types";

describe("provider types", () => {
  it("ProviderCredentials is a string map", () => {
    const c: ProviderCredentials = { FOO_KEY: "value" };
    expect(c.FOO_KEY).toBe("value");
  });

  it("PolicyEndpointSpec has cred_inject shape", () => {
    const e: PolicyEndpointSpec = {
      host: "example.com",
      port: 443,
      protocol: "rest",
      rules: [{ allow: { method: "POST", path: "/v1/**" } }],
      cred_inject: {
        provider: "anthropic",
        strip_headers: ["Authorization"],
        inject: [{ header: "Authorization", from_credential: "X" }],
      },
    };
    expect(e.host).toBe("example.com");
  });

  it("LoginIO has the expected method shape", () => {
    const io: LoginIO = {
      readLine: async () => "x",
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      isTTY: false,
    };
    expect(typeof io.readLine).toBe("function");
  });

  it("ProviderPlugin requires the full method set", () => {
    // Just type-checks; the const below would fail to compile if the interface drifts.
    const stub: ProviderPlugin = {
      id: "anthropic",
      displayName: "Anthropic",
      openshellType: "claude",
      credentialEnvVars: ["X"],
      compatibleHarnesses: new Set(["claude_code"]),
      async loginInteractive() {
        return { credentials: {} };
      },
      policyEndpoints() {
        return [];
      },
      sandboxEnvPlaceholders() {
        return {};
      },
      sandboxFiles() {
        return [];
      },
      redactionPatterns() {
        return [];
      },
    };
    expect(stub.id).toBe("anthropic");
  });
});
