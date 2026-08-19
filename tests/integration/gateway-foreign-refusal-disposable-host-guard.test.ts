// Anti-regression guard (bd openlock-kjm7) for the requireDisposableHost()
// retrofit on gateway-foreign-refusal.test.ts.
//
// WHY THIS FILE EXISTS, SEPARATELY FROM THAT TEST: the test it guards is
// gated behind `it.skipIf(!LIVE)`, so the hermetic `bun run test` gate
// (which never sets OPENLOCK_LIVE_INTEGRATION) never actually executes that
// test's body — it only registers it as skipped. A future edit that removed
// the requireDisposableHost() call (e.g. during an unrelated refactor of
// that file) would sail through `bun run lint && bun run typecheck &&
// bun run test && bun run knip` with zero red, because nothing in that
// pipeline ever runs the code path the call protects. `knip` cannot catch
// it either — its project scope is `src/**/*.ts` (knip.json), so it is
// structurally blind to everything under `tests/`, including this file and
// the one it guards. That combination (LIVE-gated body + knip's src-only
// scope) is exactly the "gated test that silently stops enforcing anything"
// shape tests/integration/disposable-host.test.ts's own header warns about
// for the CI marker; this file is the same guard for the RETROFIT rather
// than for the marker itself.
//
// THIS FILE ITSELF MUST NEVER BE LIVE-GATED. It does pure source-text
// inspection — no gateway, no podman, no network, no
// OPENLOCK_LIVE_INTEGRATION check — so it always runs as part of the
// ordinary hermetic `bun run test` gate.
//
// COMMENTS ARE STRIPPED before every check below. First-draft version of
// this guard searched the RAW source text and was fooled by its own
// explanatory prose: this file's target's SAFETY section explains the
// retrofit in English ("`requireDisposableHost()` ... is called as the
// FIRST statement", "`it.skipIf(!LIVE)` above still decides ..."), and
// those comment sentences happen to contain the exact substrings
// "requireDisposableHost(" and "it.skipIf(!LIVE)" in close proximity to
// each other — close enough that a naive `indexOf` anchored on one found
// the other inside the SAME comment block, passing green with the real
// call deleted from the actual code. Falsified 2026-08-18: with
// `requireDisposableHost(...)` deleted from the test body (leaving only
// the import and the header prose describing it), the raw-source version
// of this guard still passed 3/3 — a real false green, not a hypothetical
// one. Stripping `//` and `/* */` comments first closes that hole: only
// actual call sites in code can satisfy these checks now. Restoring the
// call and re-running confirmed 3/3 pass again with no other change.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TARGET_PATH = join(import.meta.dir, "gateway-foreign-refusal.test.ts");

/** Strips `//` line comments and `/* ... *\/` block comments so text-search
 * checks below can only match actual code, never prose that happens to
 * mention the same identifiers (see this file's header for why that
 * distinction is load-bearing, not paranoia). Not a full TS parser — good
 * enough for this one file, which contains no `//` or `/* *\/` inside
 * string literals. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

describe("gateway-foreign-refusal.test.ts is retrofitted with requireDisposableHost (bd openlock-kjm7)", () => {
  const rawSource = readFileSync(TARGET_PATH, "utf-8");
  const code = stripComments(rawSource);

  it("imports requireDisposableHost from the disposable-host helper", () => {
    // Import statements are code, not comments, but stripComments is
    // harmless to run over them too — kept consistent with the other
    // checks below rather than special-cased.
    expect(code).toMatch(
      /import\s*\{\s*requireDisposableHost\s*\}\s*from\s*["']\.\/helpers\/disposable-host["']/,
    );
  });

  it("requireDisposableHost( is actually CALLED in code (not merely imported or mentioned in a comment) inside the live test's body, after the real it.skipIf(!LIVE) call site", () => {
    const itSiteIndex = code.indexOf("it.skipIf(!LIVE)");
    expect(itSiteIndex).toBeGreaterThan(-1);

    const callIndex = code.indexOf("requireDisposableHost(", itSiteIndex);
    expect(callIndex).toBeGreaterThan(itSiteIndex);
  });

  it("requireDisposableHost( is called BEFORE the real gateway registry is captured — the ordering that makes it fail-closed rather than a check that runs too late to matter", () => {
    const callIndex = code.indexOf("requireDisposableHost(");
    const registryCaptureIndex = code.indexOf("captureRealGatewayRegistry()");
    expect(callIndex).toBeGreaterThan(-1);
    expect(registryCaptureIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeLessThan(registryCaptureIndex);
  });
});
