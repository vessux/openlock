import { HARNESSES } from "../../sandbox/harness";
import type { Issue, MountType } from "../types";

export const MANIFEST_KEYS = new Set(["harness", "mounts", "args", "env", "credentials"]);
export const MOUNT_ENTRY_KEYS = new Set(["source", "target", "type", "readOnly"]);
export const MOUNT_TYPES: readonly MountType[] = [
  "copy-once",
  "copy-refresh",
  "bind",
  "git-bundle",
];
export const CREDENTIAL_ENTRY_KEYS = new Set(["name", "values"]);
export const CREDENTIAL_SOURCE_KEYS = new Set(["from_env"]);

function err(path: string, message: string, fix?: string): Issue {
  return fix === undefined
    ? { file: "config.yaml", severity: "error", path, message }
    : { file: "config.yaml", severity: "error", path, message, fix };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateMountEntry(raw: unknown, i: number, issues: Issue[]): void {
  const where = `mounts[${i}]`;
  if (!isPlainObject(raw)) {
    issues.push(err(where, "mount entry must be a mapping"));
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!MOUNT_ENTRY_KEYS.has(key)) {
      issues.push(
        err(`${where}.${key}`, `unknown field "${key}"`, "remove it or fix the spelling"),
      );
    }
  }
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    issues.push(err(`${where}.source`, "'source' must be a non-empty string"));
  }
  if (typeof raw.target !== "string" || raw.target.length === 0) {
    issues.push(err(`${where}.target`, "'target' must be a non-empty string"));
  }
  if (typeof raw.type !== "string" || !MOUNT_TYPES.includes(raw.type as MountType)) {
    issues.push(
      err(
        `${where}.type`,
        `unknown type '${String(raw.type)}' (allowed: ${MOUNT_TYPES.join(", ")})`,
      ),
    );
  }
  if (raw.readOnly !== undefined) {
    if (typeof raw.readOnly !== "boolean") {
      issues.push(err(`${where}.readOnly`, "readOnly must be a boolean"));
    } else if (raw.type !== "bind") {
      issues.push(err(`${where}.readOnly`, "readOnly is only valid on type: bind"));
    }
  }
}

function validateMounts(doc: Record<string, unknown>, issues: Issue[]): void {
  if (doc.mounts === undefined || doc.mounts === null) return;
  if (!Array.isArray(doc.mounts)) {
    issues.push(err("mounts", "'mounts' must be a list"));
    return;
  }
  for (let i = 0; i < doc.mounts.length; i++) {
    validateMountEntry(doc.mounts[i], i, issues);
  }
}

function validateArgs(doc: Record<string, unknown>, issues: Issue[]): void {
  if (doc.args === undefined || doc.args === null) return;
  if (!Array.isArray(doc.args)) {
    issues.push(err("args", "'args' must be a list"));
    return;
  }
  for (let i = 0; i < doc.args.length; i++) {
    if (typeof doc.args[i] !== "string")
      issues.push(err(`args[${i}]`, "'args' must contain only strings"));
  }
}

function validateHarness(doc: Record<string, unknown>, issues: Issue[]): void {
  if (doc.harness === undefined || doc.harness === null) return;
  const allowed = [...HARNESSES].join(", ");
  if (typeof doc.harness !== "string" || !HARNESSES.has(doc.harness as never)) {
    issues.push(
      err(
        "harness",
        `unknown harness ${JSON.stringify(doc.harness)} (allowed: ${allowed})`,
        `set harness to one of: ${allowed}`,
      ),
    );
  }
}

function validateEnv(doc: Record<string, unknown>, issues: Issue[]): void {
  if (doc.env === undefined || doc.env === null) return;
  if (!isPlainObject(doc.env)) {
    issues.push(err("env", "'env' must be a mapping"));
    return;
  }
  for (const [k, v] of Object.entries(doc.env)) {
    if (typeof v !== "string")
      issues.push(err(`env.${k}`, `env value for '${k}' must be a string`));
  }
}

function validateCredentialEntry(raw: unknown, i: number, seen: Set<string>, issues: Issue[]): void {
  const where = `credentials[${i}]`;
  if (!isPlainObject(raw)) {
    issues.push(err(where, "credential entry must be a mapping"));
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!CREDENTIAL_ENTRY_KEYS.has(key)) {
      issues.push(err(`${where}.${key}`, `unknown field "${key}"`, "remove it or fix the spelling"));
    }
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    issues.push(err(`${where}.name`, "'name' must be a non-empty string"));
  } else if (seen.has(raw.name)) {
    issues.push(err(`${where}.name`, `duplicate credential name "${raw.name}"`));
  } else {
    seen.add(raw.name);
  }
  if (!isPlainObject(raw.values) || Object.keys(raw.values).length === 0) {
    issues.push(err(`${where}.values`, "'values' must be a non-empty mapping"));
    return;
  }
  for (const [envKey, src] of Object.entries(raw.values)) {
    const vp = `${where}.values.${envKey}`;
    if (!isPlainObject(src)) {
      issues.push(err(vp, "credential source must be a mapping like { from_env: VAR }"));
      continue;
    }
    for (const k of Object.keys(src)) {
      if (!CREDENTIAL_SOURCE_KEYS.has(k)) {
        issues.push(err(`${vp}.${k}`, `unknown source key "${k}" (allowed: from_env)`));
      }
    }
    if (typeof src.from_env !== "string" || src.from_env.length === 0) {
      issues.push(err(`${vp}.from_env`, "'from_env' must be a non-empty string"));
    }
  }
}

function validateCredentials(doc: Record<string, unknown>, issues: Issue[]): void {
  if (doc.credentials === undefined || doc.credentials === null) return;
  if (!Array.isArray(doc.credentials)) {
    issues.push(err("credentials", "'credentials' must be a list"));
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < doc.credentials.length; i++) {
    validateCredentialEntry(doc.credentials[i], i, seen, issues);
  }
}

export function validateManifestSchema(doc: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isPlainObject(doc)) {
    issues.push(err("", "config.yaml must be a mapping"));
    return issues;
  }
  for (const key of Object.keys(doc)) {
    if (!MANIFEST_KEYS.has(key)) {
      issues.push(
        err(
          key,
          `unknown key "${key}"`,
          `remove "${key}" — allowed keys: ${[...MANIFEST_KEYS].join(", ")}`,
        ),
      );
    }
  }
  validateHarness(doc, issues);
  validateMounts(doc, issues);
  validateArgs(doc, issues);
  validateEnv(doc, issues);
  validateCredentials(doc, issues);
  return issues;
}
