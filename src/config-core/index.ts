import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { checkCredentialNameCollisions, checkCredentialsSupplied } from "./cross-check";
import {
  CREDENTIAL_ENTRY_KEYS,
  CREDENTIAL_SOURCE_KEYS,
  lintManifest,
  MANIFEST_KEYS,
  MOUNT_ENTRY_KEYS,
  MOUNT_TYPES,
} from "./manifest/index";
import { ALL_POLICY_KEYS, lintPolicy } from "./policy/index";
import type { Issue } from "./types";

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

/** Load just the `credentials:` list from config.yaml via a plain YAML parse.
 * Deliberately does NOT go through `parseManifest`: that also resolves+checks
 * mount sources on disk (severity:"filesystem") and THROWS on the first such
 * issue, which would silently drop cross-file credential checks on an
 * everyday filesystem misconfig unrelated to credentials (openlock-8ir).
 * Callers only use this once the caller's own schema-clean guard already
 * proves the file parses as YAML without throwing (a syntax error would have
 * been caught by `lintManifest` and queued as severity:"error"). */
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

/** True when a .gitignore body ignores config.local.yaml (bare or root-anchored). */
export function gitignoreCoversLocalConfig(content: string | null): boolean {
  if (content === null) return false;
  return content
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === "config.local.yaml" || l === "/config.local.yaml");
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
  if (existsSync(policyPath)) {
    issues.push(...lintPolicy(readFileSync(policyPath, "utf-8")));
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
  const hasPolicyErr = issues.some((i) => i.file === "policy.yaml" && i.severity === "error");
  // Config-only: a credentials[].name colliding with a built-in provider id.
  // Runs whenever BOTH config files are schema-clean (hasConfigErr covers
  // config.yaml and config.local.yaml) — independent of policy.yaml's state,
  // since this is not a cross-file concern and must surface even when
  // policy.yaml has unrelated issues. Checked per-file (not on the merged
  // list) so the reported `file` and `credentials[i]` index are correct for
  // whichever file actually declared the colliding bundle.
  if (!hasConfigErr && existsSync(configPath)) {
    issues.push(
      ...checkCredentialNameCollisions(
        { credentials: loadDeclaredCredentials(configPath) } as Parameters<
          typeof checkCredentialNameCollisions
        >[0],
        "config.yaml",
      ),
    );
  }
  if (!hasConfigErr && existsSync(localConfigPath)) {
    issues.push(
      ...checkCredentialNameCollisions(
        { credentials: loadDeclaredCredentials(localConfigPath) } as Parameters<
          typeof checkCredentialNameCollisions
        >[0],
        "config.local.yaml",
      ),
    );
  }
  // Cross-file: injected credentials must be supplied by EITHER config file,
  // so this cross-check stays on the merged credential list (unlike the
  // per-file collision check above). Only when both config files (config.yaml
  // + config.local.yaml, via hasConfigErr) and policy.yaml have no
  // severity:"error" issues already queued — a structurally broken doc can't
  // be meaningfully cross-checked.
  if (!hasConfigErr && !hasPolicyErr && existsSync(configPath) && existsSync(policyPath)) {
    const credentials = loadDeclaredCredentialsMerged(folder);
    const policyDoc = (yaml.load(readFileSync(policyPath, "utf-8")) ?? {}) as Parameters<
      typeof checkCredentialsSupplied
    >[1];
    issues.push(
      ...checkCredentialsSupplied(
        { credentials } as Parameters<typeof checkCredentialsSupplied>[0],
        policyDoc,
      ),
    );
  }
  return issues;
}
