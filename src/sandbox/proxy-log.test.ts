import { describe, expect, it } from "bun:test";
import { buildProxyLogCmd, buildProxyLogGrepCmd, PROXY_LOG_GLOB } from "./proxy-log";

describe("buildProxyLogCmd (relocated from cli/logs.ts; see logs.test.ts for CLI-facing coverage)", () => {
  it("tails the shared PROXY_LOG_GLOB", () => {
    expect(buildProxyLogCmd()[2]).toContain(PROXY_LOG_GLOB);
  });
});

describe("buildProxyLogGrepCmd", () => {
  it("greps the shared PROXY_LOG_GLOB for the given literal", () => {
    const cmd = buildProxyLogGrepCmd("TLS termination");
    expect(cmd[0]).toBe("sh");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toContain("grep -h -F 'TLS termination'");
    expect(cmd[2]).toContain(PROXY_LOG_GLOB);
  });

  it("never fails the shell command even when nothing matches (|| true)", () => {
    expect(buildProxyLogGrepCmd("whatever")[2]).toContain("|| true");
  });
});

describe("buildProxyLogGrepCmd injection guard", () => {
  it("rejects a literal containing a single quote", () => {
    expect(() => buildProxyLogGrepCmd("a'; rm -rf /; echo '")).toThrow(/must not contain quotes/);
  });

  it("rejects a literal containing a backslash", () => {
    expect(() => buildProxyLogGrepCmd("a\\b")).toThrow(/must not contain quotes/);
  });

  it("accepts an ordinary code-controlled marker", () => {
    expect(buildProxyLogGrepCmd("TLS termination")[2]).toContain("grep -h -F 'TLS termination'");
  });
});
