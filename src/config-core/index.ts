import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { checkCredentialsSupplied } from "./cross-check";
import {
  CREDENTIAL_ENTRY_KEYS,
  CREDENTIAL_SOURCE_KEYS,
  lintManifest,
  MANIFEST_KEYS,
  MOUNT_ENTRY_KEYS,
  MOUNT_TYPES,
  parseManifest,
} from "./manifest/index";
import { ALL_POLICY_KEYS, lintPolicy } from "./policy/index";
import type { Issue } from "./types";

export { parseManifest } from "./manifest/index";
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
  // Cross-file: injected credentials must be supplied. Only when both files
  // parsed cleanly (no schema errors already queued for them) — a
  // structurally broken doc can't be meaningfully cross-checked.
  const hasConfigErr = issues.some((i) => i.file === "config.yaml" && i.severity === "error");
  const hasPolicyErr = issues.some((i) => i.file === "policy.yaml" && i.severity === "error");
  if (!hasConfigErr && !hasPolicyErr && existsSync(configPath) && existsSync(policyPath)) {
    try {
      const manifest = parseManifest(readFileSync(configPath, "utf-8"), projectDir);
      const policyDoc = (yaml.load(readFileSync(policyPath, "utf-8")) ?? {}) as Parameters<
        typeof checkCredentialsSupplied
      >[1];
      issues.push(...checkCredentialsSupplied(manifest, policyDoc));
    } catch {
      // Already validated above (schema-clean); a failure here means a
      // filesystem-only issue (e.g. offline:true suppressed a missing mount
      // source that parseManifest's unconditional offline:false re-trips) —
      // skip the cross-check rather than surface a confusing secondary error.
    }
  }
  return issues;
}
