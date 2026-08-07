import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  checkCredentialNameCollisions,
  checkCredentialsSupplied,
  checkCredInjectValuePrefix,
  checkUninjectedCredentialHost,
} from "./cross-check";
import {
  CREDENTIAL_ENTRY_KEYS,
  CREDENTIAL_SOURCE_KEYS,
  lintManifest,
  MANIFEST_KEYS,
  MOUNT_ENTRY_KEYS,
  MOUNT_TYPES,
} from "./manifest/index";
import { mergeManifestDocs } from "./manifest/merge";
import { ALL_POLICY_KEYS, lintPolicy } from "./policy/index";
import type { Issue } from "./types";

export { renderIssue } from "./format";
export { parseManifest } from "./manifest/index";
export { mergeManifestDocs } from "./manifest/merge";
export type { ConfigFile, CredentialBundle, Issue, ManifestConfig, Mount, Severity } from "./types";
export { SANDBOX_OPENLOCK_PREFIX } from "./types";

/** Every schema key/enum the config validators recognize, de-duplicated and
 * sorted. Source of truth for the agent-config-reference drift guard
 * (src/agent-reference-drift.test.ts). */
export function knownConfigTokens(): string[] {
  return [
    ...new Set<string>([
      ...MANIFEST_KEYS,
      ...MOUNT_ENTRY_KEYS,
      ...MOUNT_TYPES,
      ...CREDENTIAL_ENTRY_KEYS,
      ...CREDENTIAL_SOURCE_KEYS,
      ...ALL_POLICY_KEYS,
    ]),
  ].sort();
}

/** Load just the `credentials:` list from one config file via a plain YAML
 * parse. Deliberately does NOT go through `parseManifest`: that also
 * resolves+checks mount sources on disk (severity:"filesystem") and THROWS on
 * the first such issue, which would silently drop cross-file credential
 * checks on an everyday filesystem misconfig unrelated to credentials
 * (openlock-8ir). Callers only use this once the caller's own schema-clean
 * guard already proves the file parses as YAML without throwing (a syntax
 * error would have been caught by `lintManifest` and queued as
 * severity:"error"). Exported (openlock-j9t7) so the sandbox create-time
 * preflight (src/sandbox/policy-preflight.ts) can load config.yaml/
 * config.local.yaml PER FILE the same way `lintFolder` does — `
 * collectConfigPolicyIssues` needs the per-file split, not a merged view, to
 * attribute a name collision to the right file (see
 * loadDeclaredCredentialsMerged for the merged-view alternative). */
export function loadDeclaredCredentials(
  configPath: string,
): { name: string; values: Record<string, unknown> }[] {
  const doc = (yaml.load(readFileSync(configPath, "utf-8")) ?? {}) as { credentials?: unknown };
  return Array.isArray(doc.credentials) ? doc.credentials : [];
}

/** Credentials declared across config.yaml + config.local.yaml (base ++ local),
 * used by validate cross-checks and by report's secret redaction. */
export function loadDeclaredCredentialsMerged(
  folder: string,
): { name: string; values: Record<string, unknown> }[] {
  const out: { name: string; values: Record<string, unknown> }[] = [];
  const base = join(folder, "config.yaml");
  if (existsSync(base)) out.push(...loadDeclaredCredentials(base));
  const local = join(folder, "config.local.yaml");
  if (existsSync(local)) out.push(...loadDeclaredCredentials(local));
  return out;
}

/** True when a .gitignore body ignores config.local.yaml (bare or root-anchored).
 * openlock-ztf: `validate`'s only caller passes it `.openlock/.gitignore`'s own
 * content — this deliberately does NOT consult `git check-ignore`, so a
 * repo-root or parent `.gitignore` that also covers the file is invisible here
 * and the caller's "not covered" note fires anyway. Accepted false positive
 * (see the note text at cli/validate.ts), not a bug to fix in this function. */
export function gitignoreCoversLocalConfig(content: string | null): boolean {
  if (content === null) return false;
  return content
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === "config.local.yaml" || l === "/config.local.yaml");
}

/** Cross-file: the runtime merges config.local.yaml onto config.yaml and
 * validates the MERGED doc (parseManifest), so a collision that only appears
 * once the overlay is applied — e.g. a mount target duplicated across the two
 * files — is invisible to the per-file passes but fatal at launch. Lints the
 * merged effective config and returns only issues the per-file passes didn't
 * already report (deduped by severity+message; cross-file collisions carry a
 * message no single-file pass produced). Callers should only invoke this when
 * both files are schema-clean and a local file exists.
 *
 * openlock-ztf: two known, accepted imprecisions in the issues this returns —
 * not worth fixing without threading per-mount source-file provenance through
 * `mergeManifestDocs` (`mounts` is a plain base++local concat, per merge.ts's
 * `mergeList`), which is plumbing this cosmetic gap doesn't justify:
 *  1. `.path` (e.g. `mounts[3]`) is the index into the MERGED array, not
 *     config.local.yaml's own index — it's offset by config.yaml's mount
 *     count. The message text still names the actual colliding target, so a
 *     user isn't misled about *what* collided, only *which array slot*.
 *  2. `.file` is unconditionally `"config.local.yaml"` (see the call below)
 *     even when the collision is genuinely cross-file — i.e. one of the two
 *     colliding mounts actually lives in config.yaml. This half is more
 *     misleading than (1): the issue can point a user at the wrong file
 *     entirely for one side of the collision.
 * index.test.ts pins today's (imprecise) `.path` value in "catches a
 * cross-file duplicate mount target..." — a future provenance fix must
 * consciously update that assertion, not accidentally satisfy it. */
function lintMergedConfig(
  configPath: string,
  localConfigPath: string,
  projectDir: string,
  opts: { offline: boolean },
  alreadyReported: Issue[],
): Issue[] {
  const baseDoc = yaml.load(readFileSync(configPath, "utf-8")) ?? {};
  const localDoc = yaml.load(readFileSync(localConfigPath, "utf-8")) ?? {};
  const merged = mergeManifestDocs(baseDoc, localDoc);
  // openlock-ztf: the dedup key (severity+message) has no path component, so
  // a within-file duplicate already reported for config.local.yaml alone
  // (e.g. two local mounts sharing a target) can suppress a DIFFERENT,
  // genuinely cross-file duplicate at that same target — the message text is
  // identical either way ("duplicate target X" carries no index). Benign:
  // the within-file duplicate already told the user about target X, and once
  // that one is fixed, the cross-file duplicate (if still present) surfaces
  // on the next `validate` run since its message is no longer "already
  // reported". Not fixed — see index.test.ts's "...documented limitation..."
  // test for the pinned current behaviour.
  const known = new Set(alreadyReported.map((i) => `${i.severity} ${i.message}`));
  return lintManifest(merged, projectDir, { ...opts, file: "config.local.yaml" }).filter(
    (mi) => !known.has(`${mi.severity} ${mi.message}`),
  );
}

/** Already-loaded input for {@link collectConfigPolicyIssues}. */
export interface ConfigPolicyIssuesInput {
  /** Already-read policy.yaml content, or `undefined` if the file doesn't
   * exist / couldn't be read. `undefined` skips `lintPolicy` and every
   * check* that needs a parsed policy doc — but NOT
   * `checkCredentialNameCollisions`, which is config-only and must keep
   * running regardless (openlock-j9t7: pinned by index.test.ts's "still
   * reports a config.yaml name collision when policy.yaml does not exist at
   * all"). */
  policyContent: string | undefined;
  /** True if config.yaml OR config.local.yaml already has a severity:"error"
   * issue (schema/semantic — NOT "filesystem"; see index.test.ts's
   * "surfaces an unsupplied-credential error even when config.yaml has an
   * unrelated filesystem issue"). Callers supply this rather than the
   * function re-deriving it: computing it means re-running `lintManifest`, a
   * different pipeline this function has no business owning. The create-time
   * caller can hardcode `false` — `parseManifest` already throws before that
   * call site is reached otherwise. */
  hasConfigErr: boolean;
  /** config.yaml's declared credentials[], loaded PER FILE (not merged).
   * `checkCredentialNameCollisions` needs the per-file split to attribute the
   * right `file` and `credentials[i]` index — see index.test.ts's
   * "attributes a name-collision declared only in config.local.yaml...". */
  configCredentials: { name: string; values: Record<string, unknown> }[];
  /** config.local.yaml's declared credentials[], same per-file requirement. */
  localConfigCredentials: { name: string; values: Record<string, unknown> }[];
}

/**
 * Single source of truth for "what's wrong with this config+policy pair":
 * policy.yaml schema (`lintPolicy`) plus all four `check*` cross-checks
 * (`checkCredentialNameCollisions`, `checkUninjectedCredentialHost`,
 * `checkCredentialsSupplied`, `checkCredInjectValuePrefix`), in the same
 * gating order each already required. Pure — takes already-loaded
 * content/credentials, does no I/O of its own.
 *
 * openlock-j9t7: this replaces two hand-synced private collectors
 * (`collectNameCollisionIssues` + `collectPolicyCrossCheckIssues`) that used
 * to live here, called only from `lintFolder` and reachable only through
 * `openlock validate`. A user who ran `openlock sandbox` without ever
 * running `validate` never saw any of these checks —
 * exactly how the 2026-08-03 value_prefix 401 (openlock-64dl) reached a
 * colleague's terminal. `lintFolder` (below) and the sandbox create-time
 * preflight (src/sandbox/policy-preflight.ts) now both call this one
 * function, so a check added here can never land on only one surface again.
 */
export function collectConfigPolicyIssues(input: ConfigPolicyIssuesInput): Issue[] {
  const { policyContent, hasConfigErr, configCredentials, localConfigCredentials } = input;
  const issues: Issue[] = [];

  // Config-only, unconditional on policy.yaml's existence/state — see the
  // policyContent doc comment above.
  if (!hasConfigErr) {
    issues.push(
      ...checkCredentialNameCollisions(
        { credentials: configCredentials } as Parameters<typeof checkCredentialNameCollisions>[0],
        "config.yaml",
      ),
      ...checkCredentialNameCollisions(
        { credentials: localConfigCredentials } as Parameters<
          typeof checkCredentialNameCollisions
        >[0],
        "config.local.yaml",
      ),
    );
  }

  if (policyContent === undefined) return issues;

  const schemaIssues = lintPolicy(policyContent);
  issues.push(...schemaIssues);
  if (schemaIssues.some((i) => i.severity === "error")) return issues;

  // checkUninjectedCredentialHost's and checkCredentialsSupplied's policy
  // param share the same PolicyLike shape (cross-check.ts) — one parse, one cast.
  const policyDoc = (yaml.load(policyContent) ?? {}) as Parameters<
    typeof checkUninjectedCredentialHost
  >[0];
  issues.push(...checkUninjectedCredentialHost(policyDoc));

  if (!hasConfigErr) {
    const manifestLike = {
      credentials: [...configCredentials, ...localConfigCredentials],
    } as Parameters<typeof checkCredentialsSupplied>[0];
    issues.push(...checkCredentialsSupplied(manifestLike, policyDoc));
    issues.push(...checkCredInjectValuePrefix(manifestLike, policyDoc));
  }

  return issues;
}

/** Validate the whole .openlock/ folder (manifest + policy). Collect-all,
 * never throws. Each issue is tagged with its source file. */
export function lintFolder(projectDir: string, opts: { offline: boolean }): Issue[] {
  const folder = join(projectDir, ".openlock");
  const fix = "run `openlock init` to scaffold it";
  if (!existsSync(folder)) {
    const message = `no .openlock/ directory found in ${projectDir}`;
    return [
      { file: "config.yaml", severity: "error", path: "", message, fix },
      { file: "policy.yaml", severity: "error", path: "", message, fix },
    ];
  }
  const issues: Issue[] = [];
  const configPath = join(folder, "config.yaml");
  if (existsSync(configPath)) {
    issues.push(...lintManifest(readFileSync(configPath, "utf-8"), projectDir, opts));
  } else {
    issues.push({
      file: "config.yaml",
      severity: "error",
      path: "",
      message: "config.yaml not found",
      fix,
    });
  }
  const localConfigPath = join(folder, "config.local.yaml");
  if (existsSync(localConfigPath)) {
    issues.push(
      ...lintManifest(readFileSync(localConfigPath, "utf-8"), projectDir, {
        ...opts,
        file: "config.local.yaml",
      }),
    );
  }
  const policyPath = join(folder, "policy.yaml");
  let policyContent: string | undefined;
  if (existsSync(policyPath)) {
    policyContent = readFileSync(policyPath, "utf-8");
  } else {
    issues.push({
      file: "policy.yaml",
      severity: "error",
      path: "",
      message: "policy.yaml not found",
      fix,
    });
  }
  const hasConfigErr = issues.some(
    (i) => (i.file === "config.yaml" || i.file === "config.local.yaml") && i.severity === "error",
  );
  issues.push(
    ...collectConfigPolicyIssues({
      policyContent,
      hasConfigErr,
      configCredentials: existsSync(configPath) ? loadDeclaredCredentials(configPath) : [],
      localConfigCredentials: existsSync(localConfigPath)
        ? loadDeclaredCredentials(localConfigPath)
        : [],
    }),
  );
  // Only when both files are schema-clean (hasConfigErr false) and a local
  // file exists — see lintMergedConfig for why this pass exists.
  if (!hasConfigErr && existsSync(configPath) && existsSync(localConfigPath)) {
    issues.push(...lintMergedConfig(configPath, localConfigPath, projectDir, opts, issues));
  }
  return issues;
}
