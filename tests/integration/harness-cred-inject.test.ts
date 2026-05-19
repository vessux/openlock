// Integration test: validates that cred_inject applies to the opencode
// harness binary using a benign synthetic mock endpoint. Proves the
// harness axis end-to-end. Synthetic identifiers only.
//
// SKIPPED — requires integration infrastructure (sandbox-with-mock-HTTP
// helper) that is not yet built. See bd issue openlock-71c for follow-up.
//
// The mechanism (harness selector -> exec adapter -> policy routing ->
// cred_inject) is statically covered by unit tests:
//   - src/sandbox/harness.test.ts (resolveHarness)
//   - src/sandbox/container.test.ts (buildHarnessExecArgv per harness)
//   - src/sandbox/session.test.ts (pickSessionHarness + lifecycle)
// The Containerfile assertions in src/sandbox/default-containerfiles.test.ts
// guarantee both harness binaries are installed.

import { describe, it } from "bun:test";

describe.skip("harness cred_inject mechanism (live integration)", () => {
  it("opencode binary's request to mock has X-Test-Echo injected and X-Original-Header stripped", () => {
    // 1. Start an HTTP mock server on 127.0.0.1:8443 that captures inbound headers.
    // 2. Create a sandbox via openlock with --harness opencode and the
    //    tests/fixtures/policies/test-harness-mechanism.yaml policy.
    // 3. Pre-populate the TEST_ECHO_VAL credential.
    // 4. From inside the sandbox, issue a GET to https://mock.openlock.test:8443/
    //    with an X-Original-Header header.
    // 5. Assert the mock saw X-Test-Echo: smoke-value-12345 and did NOT see X-Original-Header.
  });
});
