import type { ParseArgsOptionsConfig } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scaffoldManifest } from "../config-core/manifest/scaffold";
import { scaffoldPolicy } from "../config-core/policy/scaffold";
import type { Mount } from "../config-core";
import { defaultPolicyContent } from "../sandbox/default-policies";
import type { Harness } from "../sandbox/harness";
import { renderSeedContainerfile } from "../sandbox/seed-containerfile";

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

interface InitIO {
  isTTY: boolean;
  write(s: string): void;
  select(question: string, options: { label: string; value: string }[], defIndex: number): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  prompt(question: string, def?: string): Promise<string>;
}

interface RenderInitOpts {
  harness: Harness;
  workdir: "bind" | "git-bundle";
  extraMounts: Mount[];
  env: Record<string, string>;
  args: string[];
}

export function renderInitFiles(opts: RenderInitOpts): Record<FileKind, string> {
  return {
    "config.yaml": scaffoldManifest({
      workdir: opts.workdir,
      extraMounts: opts.extraMounts,
      env: opts.env,
      args: opts.args,
    }),
    "policy.yaml": scaffoldPolicy(opts.harness, defaultPolicyContent()),
    Containerfile: renderSeedContainerfile(opts.harness),
  };
}

function writeFiles(folder: string, files: Record<FileKind, string>, which: FileKind[]): void {
  mkdirSync(folder, { recursive: true });
  for (const kind of which) {
    writeFileSync(join(folder, kind), files[kind], "utf-8");
  }
}

function inspectInitFolder(folder: string): FolderState {
  return {
    config: existsSync(join(folder, "config.yaml")),
    policy: existsSync(join(folder, "policy.yaml")),
    containerfile: existsSync(join(folder, "Containerfile")),
  };
}

interface RunInitArgs {
  projectPath: string;
  force: boolean;
  harness: Harness;
  io: InitIO;
  defaults?: { workdir: "bind" | "git-bundle" };
}

export async function runInit(args: RunInitArgs): Promise<number> {
  const folder = join(resolve(args.projectPath), ".openlock");
  const mode = planInit(inspectInitFolder(folder), args.force);

  if (mode.kind === "complete") {
    args.io.write(
      "`.openlock/` is complete — edit by hand, or re-run with --force to regenerate.\n",
    );
    return 0;
  }

  // NOTE: Task 7 inserts the interactive guided branch for `fresh` + TTY here.
  // Until then, every path uses sensible defaults.
  const opts: RenderInitOpts = {
    harness: args.harness,
    workdir: args.defaults?.workdir ?? "bind",
    extraMounts: [],
    env: {},
    args: [],
  };
  const files = renderInitFiles(opts);

  if (mode.kind === "fresh" || mode.kind === "regenerate") {
    writeFiles(folder, files, ["config.yaml", "policy.yaml", "Containerfile"]);
    args.io.write(
      `Wrote .openlock/config.yaml, policy.yaml, Containerfile (harness: ${args.harness}, workdir: ${opts.workdir}).\n`,
    );
    args.io.write("Review, run `openlock validate`, then `openlock sandbox`.\n");
    return 0;
  }

  // gapfill
  writeFiles(folder, files, mode.write);
  args.io.write(`Wrote ${mode.write.join(", ")} (defaults). Kept ${mode.keep.join(", ")}.\n`);
  args.io.write("Edit the regenerated file(s) as needed, then `openlock sandbox`.\n");
  return 0;
}
