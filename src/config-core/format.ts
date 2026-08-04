import type { Issue, Severity } from "./types";

/** Non-"error" severities get a bracketed tag prefix; "error" (the common
 * case) stays untagged to match the pre-existing output shape. */
const SEVERITY_TAGS: Partial<Record<Severity, string>> = {
  filesystem: "[fs] ",
  warning: "[warn] ",
};

/**
 * Render one `Issue` as the indented `path: message` (+ optional `fix:`) line
 * shape `openlock validate` prints. Moved here (openlock-j9t7) from
 * `cli/validate.ts` — the sandbox create-time preflight
 * (src/sandbox/policy-preflight.ts) needs the SAME per-issue line shape to
 * print blocking/warning issues, and this project has been burned twice by a
 * fixture drifting from the real product output (see
 * feedback_fixtures_must_match_product_output.md) — duplicating this string
 * shape in a second place was exactly that risk. Both `cli/validate.ts` and
 * `sandbox/policy-preflight.ts` already depend on `config-core`, so this adds
 * no new dependency edge in either direction.
 */
export function renderIssue(issue: Issue): string[] {
  const loc = issue.path ? `${issue.path}: ` : "";
  const tag = SEVERITY_TAGS[issue.severity] ?? "";
  const lines = [`    ${tag}${loc}${issue.message}`];
  if (issue.fix) lines.push(`      fix: ${issue.fix}`);
  return lines;
}
