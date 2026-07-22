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
  // have no severity:"error" issues already queued for them — a structurally
  // broken doc can't be meaningfully cross-checked. Deliberately does NOT go
  // through parseManifest: that also resolves+checks mount sources on disk
  // (severity:"filesystem", which does not gate this block) and THROWS on the
  // first such issue, which would silently drop the cross-check on an
  // everyday filesystem misconfig unrelated to credentials (openlock-8ir). A
  // plain yaml.load of each file is enough — checkCredentialsSupplied only
  // reads manifest.credentials, and the schema-clean guard above already
  // proves both files parse as YAML without throwing (a syntax error would
  // have been caught by lintManifest/lintPolicy and queued as
  // severity:"error").
  const hasConfigErr = issues.some((i) => i.file === "config.yaml" && i.severity === "error");
  const hasPolicyErr = issues.some((i) => i.file === "policy.yaml" && i.severity === "error");
  if (!hasConfigErr && !hasPolicyErr && existsSync(configPath) && existsSync(policyPath)) {
    const manifestDoc = (yaml.load(readFileSync(configPath, "utf-8")) ?? {}) as {
      credentials?: unknown;
    };
    const credentials = Array.isArray(manifestDoc.credentials) ? manifestDoc.credentials : [];
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
