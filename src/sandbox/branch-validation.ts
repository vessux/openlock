import type { Mount } from "./mounts";

export function validateBranchFlagAgainstWorkdir(
  branch: string | undefined,
  workdir: Mount | undefined,
): string | null {
  if (branch === undefined) return null;
  if (branch.includes("'")) {
    return "--branch must not contain single-quote characters";
  }
  if (workdir === undefined) {
    return "--branch requires a git-bundle workdir; no workdir mount declared";
  }
  if (workdir.type !== "git-bundle") {
    return `--branch is only valid with git-bundle workdir; the declared workdir mount has type: ${workdir.type}`;
  }
  return null;
}
