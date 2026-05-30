import type { Issue, MountType } from "../types";

const MANIFEST_KEYS = new Set(["mounts", "args", "env"]);
const MOUNT_ENTRY_KEYS = new Set(["source", "target", "type", "readOnly"]);
const MOUNT_TYPES: readonly MountType[] = ["copy-once", "copy-refresh", "bind", "git-bundle"];

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
  validateMounts(doc, issues);
  validateArgs(doc, issues);
  validateEnv(doc, issues);
  return issues;
}
