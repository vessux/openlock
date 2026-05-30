import type { ParseArgsOptionsConfig } from "node:util";

export const flagSchema = {
  force: { type: "boolean" },
  harness: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

type FileKind = "config.yaml" | "policy.yaml" | "Containerfile";

const ALL_FILES: FileKind[] = ["config.yaml", "policy.yaml", "Containerfile"];

export interface FolderState {
  config: boolean;
  policy: boolean;
  containerfile: boolean;
}

type InitMode =
  | { kind: "fresh" }
  | { kind: "complete" }
  | { kind: "gapfill"; write: FileKind[]; keep: FileKind[] }
  | { kind: "regenerate"; write: FileKind[] };

function present(state: FolderState): FileKind[] {
  const out: FileKind[] = [];
  if (state.config) out.push("config.yaml");
  if (state.policy) out.push("policy.yaml");
  if (state.containerfile) out.push("Containerfile");
  return out;
}

export function planInit(state: FolderState, force: boolean): InitMode {
  if (force) return { kind: "regenerate", write: [...ALL_FILES] };
  const have = present(state);
  if (have.length === 0) return { kind: "fresh" };
  if (have.length === ALL_FILES.length) return { kind: "complete" };
  return {
    kind: "gapfill",
    write: ALL_FILES.filter((f) => !have.includes(f)),
    keep: have,
  };
}
