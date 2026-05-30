import { describe, expect, it } from "bun:test";
import { lintPolicy } from "./index";
import { scaffoldPolicy } from "./scaffold";

const DEFAULT = `version: 1
filesystem_policy:
  include_workdir: true
  read_write:
    - /sandbox
process:
  run_as_user: sandbox
  run_as_group: sandbox
network_policies:
  claude_code:
    binaries:
      - path: /usr/local/bin/claude
    endpoints:
      - host: api.anthropic.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow:
              method: POST
              path: /v1/**
    allowed_secrets: []
  opencode:
    binaries:
      - path: /usr/local/bin/opencode
    endpoints:
      - host: api.anthropic.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow:
              method: POST
              path: /v1/**
    allowed_secrets: []
  npm_packages:
    binaries:
      - path: /usr/local/bin/npm
    endpoints:
      - host: registry.npmjs.org
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
    allowed_secrets: []
`;

describe("scaffoldPolicy", () => {
  it("keeps the chosen harness + shared keys, drops the other harness", () => {
    const out = scaffoldPolicy("claude_code", DEFAULT);
    expect(out).toContain("claude_code:");
    expect(out).toContain("npm_packages:");
    expect(out).not.toMatch(/^\s+opencode:/m);
  });

  it("emits a pointer comment naming the dropped harness", () => {
    const out = scaffoldPolicy("claude_code", DEFAULT);
    expect(out).toContain("openlock init --harness opencode");
  });

  it("throws on a harness with no registry block", () => {
    expect(() => scaffoldPolicy("nonexistent", DEFAULT)).toThrow(/nonexistent/);
  });

  it("lints clean", () => {
    expect(lintPolicy(scaffoldPolicy("claude_code", DEFAULT))).toEqual([]);
    expect(lintPolicy(scaffoldPolicy("opencode", DEFAULT))).toEqual([]);
  });
});
