// Static gate over test-authored source (bd openlock-q7b8, split from
// openlock-6pwu). Wired into the `test` job in .github/workflows/test.yml,
// same shape as scripts/check-live-integration-residue.ts's own step:
// prefix/pattern-scoped, READ-ONLY, only ever fails loudly. This script
// never deletes or modifies anything — it only scans and reports.
//
// WHY THIS SCRIPT HAS TO EXIST, RATHER THAN LEANING ON AN EXISTING TOOL:
// `knip`'s project scope is `src/**/*.ts` (knip.json:3), so it never even
// SEES most of what this script scans — but that blind spot is only half
// the reason. The deeper reason is that "does a test reach real host state
// by omission" isn't an unused-export question at all, so knip would not
// catch this even for the `src/**/*.test.ts` files that ARE inside its
// scope (see the print-base-tag.test.ts / prune-images.test.ts examples
// below, both under src/cli/ and both real historical offenders). Neither
// `bun run lint` (biome) nor `bun run typecheck` (tsc) has any rule for
// "this spawn's env silently inherits the real environment" either. This
// gap is exactly how BOTH of this project's real credential-loss incidents
// happened (feedback_tests_synthetic_state_only.md) — neither went through
// `src/tokens.ts`'s own API at all, so a check scoped to that module would
// have missed both.
//
// TWO INDEPENDENT RULES:
//
// RULE 1 — UNSAFE ENTRYPOINT SPAWN. Flags a `Bun.spawn`/`Bun.spawnSync` call
// that runs openlock's own CLI (`src/cli.ts` directly, or a `bun build
// --compile`d binary built earlier in the same file) whose env sets NEITHER
// `HOME` NOR `OPENLOCK_STATE_DIR` — including a call that passes no `env`
// key at all, which inherits the developer's real environment wholesale.
// This is deliberately NOT a check for the literal string
// `OPENLOCK_STATE_DIR` alone: `resolveStateDir()`'s precedence is `explicit
// > OPENLOCK_STATE_DIR > HOME-relative default`, so a spawn that overrides
// `HOME` (and leaves OPENLOCK_STATE_DIR unset) is ALREADY isolated and must
// not be flagged — src/cli/list-sessions-cli.test.ts and src/cli/global-
// flags.test.ts are exactly this shape. Flagging safe files is how a gate
// gets silenced instead of fixed, which is the actual failure mode this
// header is warning a future editor away from — see this ticket's own
// falsification run for the concrete numbers.
//
// LIVE-GATED FILES ARE OUT OF SCOPE FOR RULE 1, ON PURPOSE. A file that
// mentions `OPENLOCK_LIVE_INTEGRATION` anywhere is skipped entirely for
// this rule: real-gateway/real-podman access from a LIVE-gated test is a
// SEPARATE, already-governed risk surface (`OPENLOCK_DISPOSABLE_HOST` /
// `requireDisposableHost()`, bd openlock-o4t4/openlock-kjm7), not this
// script's job. Concretely: tests/integration/compiled-binary-gateway-
// start.test.ts spawns a compiled binary with no env override at all, by
// DESIGN — it deliberately restarts the real shared dev gateway (documented
// in its own SAFETY section as the accepted "stop+start is the repair
// flow" tradeoff) — and this rule must not re-litigate that as if it were
// an accidental hermetic leak.
//
// RULE 2 — RAW REAL-CREDENTIALS-PATH CONSTRUCTION. Flags a `join(...)` call
// that combines a HOME-source token (`homedir()` or `process.env.HOME`)
// with the literal, adjacent string pair `".config", "openlock"` — the
// exact shape of the real credentials file's path, and the actual shape of
// BOTH historical credential-loss incidents (neither incident went through
// `src/tokens.ts`'s `credentialsPath()` at all; both hand-rolled this same
// join). This rule is NOT skipped for LIVE-gated files — the one deliberate
// exception (below) is allowlisted by file path, not by LIVE-gating, so a
// SECOND live test that reached for the same raw construction would still
// be caught.
//
// THE ONE ALLOWED EXCEPTION: tests/integration/helpers/real-credentials.ts
// is the extracted, read-only-by-construction, OPENLOCK_LIVE_INTEGRATION-
// gated carve-out for tests/integration/post-create-openrouter-real.test.ts
// (bd openlock-q7b8) — seeing whether a real bearer token is actually
// accepted by the real OpenRouter API has no synthetic substitute. That one
// exact file path is allowlisted below. Deliberately NOT a broad env-var
// escape hatch (e.g. `OPENLOCK_ALLOW_REAL_STATE=1`) — that would silence
// this rule for every FUTURE offender, not just this one documented reader.
//
// HONEST LIMITS — READ BEFORE TRUSTING A GREEN RUN:
//   - This is textual pattern matching, not a real TypeScript parser. It
//     cannot see an env object built dynamically or spread from a helper
//     function whose own body isolates HOME/OPENLOCK_STATE_DIR — a call
//     like `Bun.spawn(argv, buildSafeEnv())` reads as "no HOME, no
//     OPENLOCK_STATE_DIR" even if `buildSafeEnv()` sets both internally.
//   - Rule 1's "compiled binary" detection only recognizes the variable
//     bound by `--outfile=${name}` in a `bun build --compile` call earlier
//     in the SAME file, and only when that same identifier is later spawned
//     as the first argv element (`[name, ...]`). A binary path threaded in
//     any other shape (a different variable name per call, a binary built
//     in a shared helper) is invisible to it.
//   - It cannot catch a DELIBERATE wrong choice — a spawn that explicitly
//     sets `HOME` or `OPENLOCK_STATE_DIR` to the REAL default path on
//     purpose passes this check; only unintentional omission is in scope.
//   - Rule 2 only recognizes the credentials/config path's exact literal
//     shape (`".config", "openlock"` as adjacent join arguments alongside a
//     HOME-source token). A differently-shaped reconstruction (e.g. string
//     concatenation instead of `join()`, or splitting the literals across
//     two separate `join()` calls) would not be recognized.
//   - Comments are stripped before matching (line comments blanked to end
//     of line, block comments blanked but newlines preserved, so reported
//     line numbers stay accurate) specifically because a first draft of a
//     sibling guard in this same ticket batch was fooled by its own
//     explanatory prose repeating the exact substrings it was matching —
//     see tests/integration/gateway-foreign-refusal-disposable-host-
//     guard.test.ts's header for that concrete incident. Comment-stripping
//     here exists for the identical reason.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// An optional CLI arg overrides the scan root — used ONLY for falsifying
// this script's own detection rules against a scratch directory built from
// historical (pre-fix) file content, never in normal CI/local use (the
// wired-in CI step and `bun run scripts/check-real-state-access.ts` both
// call this with no argument, so production behavior is unaffected).
const REPO_ROOT = process.argv[2] ? resolve(process.argv[2]) : join(import.meta.dir, "..");

// The ONE sanctioned reader of the real credentials file. See this script's
// header for why an allowlist-by-path, not a broad env escape hatch.
const RULE_2_ALLOWLIST = new Set<string>(["tests/integration/helpers/real-credentials.ts"]);

interface Violation {
  file: string;
  line: number;
  rule: 1 | 2;
  message: string;
  snippet: string;
}

function listTsFiles(dir: string, onlyTestFiles: boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full, onlyTestFiles));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (onlyTestFiles && !entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/** Files this gate scans: every `.ts` file under tests/ (test bodies AND
 * their helpers — a helper can hand-roll an unsafe pattern just as easily
 * as a test file can), plus only `*.test.ts` files under src/ and scripts/
 * — production code there is covered by other seams/review; this gate's
 * job is test-authored access, not production path resolution. */
function gatherFiles(): string[] {
  return [
    ...listTsFiles(join(REPO_ROOT, "tests"), false),
    ...listTsFiles(join(REPO_ROOT, "src"), true),
    ...listTsFiles(join(REPO_ROOT, "scripts"), true),
  ];
}

/** Blanks `//` line comments (up to end of line) and `/* ... *\/` block
 * comments (contents only, newlines preserved) so every match below can
 * only fire against actual code — never prose that happens to mention the
 * same identifiers. Preserves every original line's length/position so a
 * line number computed against the OUTPUT is still correct against the
 * INPUT. */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function lineNumberAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

const IDENTIFIER_CHAR = /[\w$]/;

/**
 * Finds every call to a bare-identifier function named exactly by `marker`
 * (e.g. "join" or "Bun.spawn") and returns each call's full, PAREN-BALANCED
 * argument text (including the outer parens). Requires a non-identifier,
 * non-`.` character immediately before the marker, so `array.join(...)`
 * (a method call) is never mistaken for the bare `join(...)` this project's
 * `node:path` import uses — without that boundary check, matching the
 * substring "join(" would also fire on every `.join(...)` Array/string call
 * in the codebase, of which there are many. Parens and braces inside string
 * or template literals are not counted, so a literal like
 * `` `--outfile=${x})` `` can't desynchronize the balance count.
 */
function extractCalls(src: string, marker: string): { argsText: string; startIndex: number }[] {
  const results: { argsText: string; startIndex: number }[] = [];
  const fullMarker = `${marker}(`;
  let searchFrom = 0;
  while (true) {
    const idx = src.indexOf(fullMarker, searchFrom);
    if (idx === -1) break;
    const precedingChar = idx > 0 ? src[idx - 1] : "";
    if (precedingChar && (IDENTIFIER_CHAR.test(precedingChar) || precedingChar === ".")) {
      searchFrom = idx + fullMarker.length;
      continue;
    }
    const openParenIdx = idx + fullMarker.length - 1;
    let depth = 0;
    let i = openParenIdx;
    let inString: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inString) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inString = c;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    results.push({ argsText: src.slice(openParenIdx, i), startIndex: openParenIdx });
    searchFrom = Math.max(i, idx + fullMarker.length);
  }
  return results;
}

const CLI_LITERAL = '"src/cli.ts"';
// Matches ["bun", "build" — the `bun build --compile` invocation shape this
// rule must NOT flag (it never touches state; it only compiles). A bare
// substring check for "build" would also match an unrelated flag like
// "--rebuild", so this anchors specifically to "bun" immediately followed
// by the "build" array element.
const BUN_BUILD_SHAPE = /\[\s*["']bun["']\s*,\s*["']build["']/;
const OUTFILE_VAR = /--outfile=\$\{(\w+)\}/;

function checkRule1(relPath: string, rawSource: string): Violation[] {
  const stripped = stripComments(rawSource);
  if (stripped.includes("OPENLOCK_LIVE_INTEGRATION")) {
    // Real-gateway/real-podman access from a LIVE-gated test is governed
    // separately (OPENLOCK_DISPOSABLE_HOST) — see this script's header.
    return [];
  }

  const compiledBinaryMatch = stripped.match(OUTFILE_VAR);
  const compiledBinaryVar = compiledBinaryMatch ? compiledBinaryMatch[1] : null;
  const compiledBinaryShape = compiledBinaryVar
    ? new RegExp(`\\[\\s*${compiledBinaryVar}\\s*[,\\]]`)
    : null;

  const calls = [...extractCalls(stripped, "Bun.spawn"), ...extractCalls(stripped, "Bun.spawnSync")];
  const violations: Violation[] = [];
  for (const { argsText, startIndex } of calls) {
    const isDirectCliInvocation = argsText.includes(CLI_LITERAL) && !BUN_BUILD_SHAPE.test(argsText);
    const isCompiledBinaryInvocation = compiledBinaryShape ? compiledBinaryShape.test(argsText) : false;
    if (!isDirectCliInvocation && !isCompiledBinaryInvocation) continue;

    const hasHome = /\bHOME\b/.test(argsText);
    const hasStateDir = /\bOPENLOCK_STATE_DIR\b/.test(argsText);
    if (hasHome || hasStateDir) continue;

    violations.push({
      file: relPath,
      line: lineNumberAt(stripped, startIndex),
      rule: 1,
      message: isDirectCliInvocation
        ? "spawns src/cli.ts with neither HOME nor OPENLOCK_STATE_DIR set in its env " +
          "(or no env at all) — this inherits the real environment and can touch the " +
          "developer's real state dir / real credentials.json"
        : "spawns the compiled binary built earlier in this file with neither HOME nor " +
          "OPENLOCK_STATE_DIR set in its env (or no env at all)",
      snippet: argsText.slice(0, 120).replace(/\s+/g, " "),
    });
  }
  return violations;
}

const HOME_SOURCE = /\bhomedir\(\)|\bprocess\.env\.HOME\b/;
const CONFIG_OPENLOCK_PAIR = /["']\.config["']\s*,\s*["']openlock["']/;

function checkRule2(relPath: string, rawSource: string): Violation[] {
  if (RULE_2_ALLOWLIST.has(relPath)) return [];

  const stripped = stripComments(rawSource);
  const calls = extractCalls(stripped, "join");
  const violations: Violation[] = [];
  for (const { argsText, startIndex } of calls) {
    if (HOME_SOURCE.test(argsText) && CONFIG_OPENLOCK_PAIR.test(argsText)) {
      violations.push({
        file: relPath,
        line: lineNumberAt(stripped, startIndex),
        rule: 2,
        message:
          "constructs the real credentials/config path (homedir()/process.env.HOME joined " +
          'with ".config", "openlock") directly, outside the one allowlisted helper — this ' +
          "is the exact shape of both this project's real credential-loss incidents",
        snippet: argsText.slice(0, 120).replace(/\s+/g, " "),
      });
    }
  }
  return violations;
}

function main(): void {
  const files = gatherFiles();
  const violations: Violation[] = [];
  for (const file of files) {
    const relPath = relative(REPO_ROOT, file);
    const raw = readFileSync(file, "utf-8");
    violations.push(...checkRule1(relPath, raw));
    violations.push(...checkRule2(relPath, raw));
  }

  if (violations.length === 0) {
    console.log(
      `openlock-q7b8: real-state-access check clean — scanned ${files.length} file(s), no ` +
        "unsafe entrypoint spawns or raw real-credentials-path construction found.",
    );
    return;
  }

  console.error(
    "openlock-q7b8: found test-authored code that can reach REAL host state. This is " +
      "read-only static analysis — nothing was touched, but see feedback_tests_synthetic_" +
      "state_only.md for why this must be fixed, not silenced:\n",
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [rule ${v.rule}] ${v.message}`);
    console.error(`      ${v.snippet}${v.snippet.length >= 120 ? "..." : ""}`);
  }
  console.error(
    `\n${violations.length} violation(s) across ${files.length} scanned file(s). See this ` +
      "script's own header for exactly what each rule catches, its known limits, and the " +
      "one allowlisted exception.",
  );
  process.exit(1);
}

main();
