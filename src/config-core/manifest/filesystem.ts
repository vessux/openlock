import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Issue, MountType } from "../types";

function fsIssue(path: string, message: string): Issue {
  return { file: "config.yaml", severity: "filesystem", path, message };
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

export function resolveSource(projectRoot: string, raw: string): string {
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
}

interface RawMount {
  source?: unknown;
  target?: unknown;
  type?: unknown;
  readOnly?: unknown;
}

// Runs only after schema passes, so source/type are valid. Each mount yields at
// most one issue, in the runtime's order (existence -> kind -> git-tree).
export function validateManifestFilesystem(
  doc: Record<string, unknown>,
  projectRoot: string,
): Issue[] {
  const issues: Issue[] = [];
  const mounts = Array.isArray(doc.mounts) ? (doc.mounts as RawMount[]) : [];
  mounts.forEach((m, i) => {
    const where = `mounts[${i}]`;
    const type = m.type as MountType;
    const source = resolveSource(projectRoot, m.source as string);
    if (!existsSync(source)) {
      issues.push(fsIssue(`${where}.source`, `source ${source} does not exist`));
      return;
    }
    const isDir = statSync(source).isDirectory();
    if ((type === "copy-once" || type === "copy-refresh" || type === "git-bundle") && !isDir) {
      issues.push(fsIssue(`${where}.source`, `source ${source} is not a directory`));
      return;
    }
    if (type === "git-bundle" && !existsSync(join(source, ".git"))) {
      issues.push(
        fsIssue(`${where}.source`, `source ${source} is not a git working tree (missing .git)`),
      );
    }
  });
  return issues;
}
