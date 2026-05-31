import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownConfigTokens } from "./config-core/index";
import { HARNESSES } from "./sandbox/harness";

// The agent reference lives at repo-root docs/; this test file is in src/.
const DOC_PATH = join(import.meta.dir, "..", "docs", "agent-config-reference.md");

describe("agent-config-reference.md drift guard", () => {
  // NOTE: read at collection time — if the doc is missing this throws ENOENT
  // and the whole file fails as one suite error rather than per-token failures.
  const text = readFileSync(DOC_PATH, "utf-8");
  // Every config key/enum the validators recognize, plus every harness, must
  // be mentioned in the reference. Catches "added a schema field, forgot to
  // document it". Note: generic short keys (e.g. "host", "port") pass
  // trivially — the distinctive keys (cred_inject, strip_headers, ...) are the
  // real guard.
  const tokens = [...new Set<string>([...knownConfigTokens(), ...HARNESSES])];

  for (const token of tokens) {
    it(`documents config token: ${token}`, () => {
      expect(text).toContain(token);
    });
  }
});
