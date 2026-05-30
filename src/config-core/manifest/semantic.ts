import { basename } from "node:path";
import type { Issue, MountType } from "../types";
import { SANDBOX_OPENLOCK_PREFIX } from "../types";

const RESERVED_MOUNT_NAMES: ReadonlySet<string> = new Set([".gitconfig", "bundles"]);

function err(path: string, message: string): Issue {
  return { file: "config.yaml", severity: "error", path, message };
}

// Mirrors the runtime mount rules (formerly mounts.ts commonTargetChecks +
// validateTargetForType). Returns at most one issue per target, in the same
// order the runtime threw, so parse-throw mode preserves prior error messages.
function commonTargetIssue(target: string, where: string): Issue[] {
  if (!target.startsWith("/")) {
    return [err(`${where}.target`, `mount target must be absolute: ${target}`)];
  }
  if (target.split("/").includes("..")) {
    return [err(`${where}.target`, `mount target must not contain '..' segments: ${target}`)];
  }
  if (target.startsWith(SANDBOX_OPENLOCK_PREFIX)) {
    const top = target.slice(SANDBOX_OPENLOCK_PREFIX.length).split("/")[0];
    if (top !== undefined && RESERVED_MOUNT_NAMES.has(top)) {
      return [
        err(
          `${where}.target`,
          `mount target conflicts with openlock-internal name '${top}': ${target}`,
        ),
      ];
    }
  }
  return [];
}

function copyTargetIssue(target: string, type: MountType, where: string): Issue[] {
  if (target === "/sandbox/repo") {
    return [
      err(
        `${where}.target`,
        `target /sandbox/repo not supported with type '${type}'; use git-bundle (host repo bundled in) or bind (live host sync), or omit the workdir mount`,
      ),
    ];
  }
  if (
    !target.startsWith(SANDBOX_OPENLOCK_PREFIX) ||
    target.length <= SANDBOX_OPENLOCK_PREFIX.length
  ) {
    return [
      err(
        `${where}.target`,
        `mount target must be under /sandbox/.openlock/ for type '${type}': ${target}`,
      ),
    ];
  }
  return [];
}

function targetIssues(target: string, type: MountType, where: string): Issue[] {
  const common = commonTargetIssue(target, where);
  if (common.length > 0) return common;
  if (type === "copy-once" || type === "copy-refresh") return copyTargetIssue(target, type, where);
  if (type === "git-bundle" && target.startsWith(SANDBOX_OPENLOCK_PREFIX)) {
    return [
      err(`${where}.target`, `git-bundle target must not be under /sandbox/.openlock/: ${target}`),
    ];
  }
  return [];
}

interface RawMount {
  source?: unknown;
  target?: unknown;
  type?: unknown;
  readOnly?: unknown;
}

// Runs only after validateManifestSchema passes, so source/target/type are valid.
export function validateManifestSemantics(doc: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  const mounts = Array.isArray(doc.mounts) ? (doc.mounts as RawMount[]) : [];
  const targets = new Set<string>();
  const bundleBasenames = new Map<string, number>();
  mounts.forEach((m, i) => {
    const where = `mounts[${i}]`;
    const target = m.target as string;
    const type = m.type as MountType;
    issues.push(...targetIssues(target, type, where));
    if (targets.has(target)) {
      issues.push(err(`${where}.target`, `duplicate target ${target}`));
    } else {
      targets.add(target);
    }
    if (type === "git-bundle") {
      const base = basename(m.source as string);
      const prev = bundleBasenames.get(base);
      if (prev !== undefined) {
        issues.push(
          err(
            where,
            `source basename '${base}' collides between git-bundle mounts (already used by mounts[${prev}])`,
          ),
        );
      } else {
        bundleBasenames.set(base, i);
      }
    }
  });
  return issues;
}
