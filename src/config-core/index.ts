import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintManifest } from "./manifest/index";
import { MANIFEST_KEYS, MOUNT_ENTRY_KEYS, MOUNT_TYPES } from "./manifest/schema";
import { lintPolicy } from "./policy/index";
import { ALL_POLICY_KEYS } from "./policy/schema";
import type { Issue } from "./types";

export { parseManifest } from "./manifest/index";
export type { ConfigFile, Issue, ManifestConfig, Mount, Severity } from "./types";
export { SANDBOX_OPENLOCK_PREFIX } from "./types";

/** Every schema key/enum the config validators recognize, de-duplicated and
 * sorted. Source of truth for the agent-config-reference drift guard
 * (src/agent-reference-drift.test.ts). */
export function knownConfigTokens(): string[] {
  return [
    ...new Set<string>([...MANIFEST_KEYS, ...MOUNT_ENTRY_KEYS, ...MOUNT_TYPES, ...ALL_POLICY_KEYS]),
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
  return issues;
}
