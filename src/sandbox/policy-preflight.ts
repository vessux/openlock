import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue } from "../config-core";
import { collectConfigPolicyIssues, loadDeclaredCredentials, renderIssue } from "../config-core";

/**
 * Read + evaluate a project's `.openlock/policy.yaml` (plus config.yaml/
 * config.local.yaml declared credentials) through the SAME
 * `collectConfigPolicyIssues` single source of truth `openlock validate`
 * uses (openlock-j9t7) — closing the gap where every cross-check
 * (checkCredentialsSupplied, checkUninjectedCredentialHost,
 * checkCredInjectValuePrefix, checkCredentialNameCollisions) and policy.yaml
 * schema validation were reachable ONLY via `openlock validate`, invisible to
 * a user who ran `openlock sandbox` directly — exactly how the 2026-08-03
 * `value_prefix` 401 (openlock-64dl) reached a colleague's terminal.
 *
 * `hasConfigErr` is hardcoded `false`: by the time `runSandbox` reaches this
 * call, `resolveRepoPolicy` → `resolveOpenlockFolder` → `parseManifest` has
 * already thrown on any config.yaml/config.local.yaml schema/semantic/
 * filesystem error, so config.yaml is guaranteed schema-clean here — this
 * function has no business re-deriving that.
 *
 * Never throws: a policy.yaml that can't be read (e.g. a `--policy` override
 * pointing outside `.openlock/`) yields no issues rather than crashing
 * sandbox create/reattach over a preflight nicety — openshell itself is the
 * authority on whether that path is valid.
 */
export function collectSandboxPolicyIssues(openlockFolder: string, policyPath: string): Issue[] {
  let policyContent: string | undefined;
  try {
    policyContent = readFileSync(policyPath, "utf-8");
  } catch {
    policyContent = undefined;
  }
  const configPath = join(openlockFolder, "config.yaml");
  const localConfigPath = join(openlockFolder, "config.local.yaml");
  return collectConfigPolicyIssues({
    policyContent,
    hasConfigErr: false,
    configCredentials: existsSync(configPath) ? loadDeclaredCredentials(configPath) : [],
    localConfigCredentials: existsSync(localConfigPath)
      ? loadDeclaredCredentials(localConfigPath)
      : [],
  });
}

export interface PolicyPreflightOpts {
  /**
   * True when the on-disk policy/config being checked is about to be baked
   * into a container this run (fresh create, forced/accepted `--rebuild`
   * recreate) — false when it's a plain reattach to an already-running
   * container, which keeps its already-baked policy regardless of what's on
   * disk now.
   */
  policyWillBeApplied: boolean;
}

/**
 * Decide whether a collected issue set should BLOCK sandbox create/recreate
 * or only warn (openlock-j9t7 / D3).
 *
 * - `policyWillBeApplied: true` (fresh create, forced/accepted `--rebuild`
 *   recreate): an error-severity issue blocks. The container is about to be
 *   built with the exact defect `openlock validate` would have caught
 *   (unresolvable credential, wrong `value_prefix`, a policy.yaml schema
 *   error) — refusing now converts a guaranteed-eventual, unnamed 401 into a
 *   named, fixable message at the moment the user is present.
 * - `policyWillBeApplied: false` (plain reattach — no drift, or drift the
 *   user declined to rebuild): the running container's baked-in policy is
 *   UNCHANGED regardless of what's wrong on disk right now, so the same
 *   error is not live in it. Blocking here would lock a user out of a
 *   working session over a defect that isn't actually running — over-
 *   protection, and worse, a "your credential injection is broken" message
 *   would be false about the container that's actually up. Warn only.
 */
export function decidePolicyPreflightAction(
  issues: readonly Issue[],
  opts: PolicyPreflightOpts,
): { block: boolean } {
  return { block: opts.policyWillBeApplied && issues.some((i) => i.severity === "error") };
}

/**
 * Render a preflight issue set to the lines `openlock sandbox` should print:
 * a header naming whether these issues are about to be baked in or are only
 * a report on an inert on-disk config, followed by one line (+ optional fix)
 * per `Issue` via the SAME `renderIssue` formatter `openlock validate` uses
 * (config-core/format.ts) — so this project's fixtures-must-match-real-
 * output rule holds for the sandbox surface too, not just validate's.
 * Returns `[]` when there's nothing to say.
 */
export function formatPolicyPreflightLines(
  issues: readonly Issue[],
  opts: PolicyPreflightOpts,
): string[] {
  if (issues.length === 0) return [];
  const { block } = decidePolicyPreflightAction(issues, opts);
  const header = block
    ? "openlock: .openlock/ policy/config preflight found blocking issue(s) — this sandbox would ship with them:"
    : opts.policyWillBeApplied
      ? "openlock: .openlock/ policy/config preflight found non-blocking issue(s) that will be baked into this sandbox:"
      : "openlock: .openlock/ policy/config preflight found issue(s) in the on-disk config. " +
        "These do NOT affect the currently running sandbox — they will only take effect on the " +
        "next rebuild (`openlock sandbox --rebuild`) or recreate:";
  return [
    header,
    ...issues.flatMap((i) => renderIssue(i)),
    "Run `openlock validate` for the full report.",
  ];
}

/**
 * Print the preflight result and, if blocking, exit(1). Thin wrapper over
 * the two pure functions above — mirrors the existing
 * `exitOnPreflightFailure`/`enforceTlsTerminationHealthy` shape in
 * session.ts (console + process.exit, not unit-tested directly; the pure
 * decision/formatting it wraps is what's tested).
 */
export function enforcePolicyPreflight(issues: readonly Issue[], opts: PolicyPreflightOpts): void {
  const lines = formatPolicyPreflightLines(issues, opts);
  if (lines.length === 0) return;
  const { block } = decidePolicyPreflightAction(issues, opts);
  for (const line of lines) {
    if (block) console.error(line);
    else console.warn(line);
  }
  if (block) process.exit(1);
}
