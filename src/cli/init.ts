import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import type { Mount } from "../config-core";
import { scaffoldManifest } from "../config-core/manifest/scaffold";
import { scaffoldPolicy } from "../config-core/policy/scaffold";
import { readGlobalConfig } from "../global-config";
import { defaultPolicyContent } from "../sandbox/default-policies";
import type { Harness } from "../sandbox/harness";
import { harnessChoices, harnessDefaultIndex, resolveHarness } from "../sandbox/harness";
import { renderSeedContainerfile } from "../sandbox/seed-containerfile";
import { printCmdHelp } from "./_help";

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
  select(
    question: string,
    options: { label: string; value: string }[],
    defIndex: number,
  ): Promise<string>;
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
      harness: opts.harness,
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

async function collectGuided(io: InitIO, defaultHarness: Harness): Promise<RenderInitOpts> {
  const workdir = (await io.select(
    "Workdir mount type",
    [
      { label: "bind (live; host edits <-> sandbox)", value: "bind" },
      { label: "git-bundle (isolated snapshot; required for --branch)", value: "git-bundle" },
    ],
    0,
  )) as "bind" | "git-bundle";

  const harness = (await io.select(
    "Harness for this project (shapes policy + Containerfile)",
    harnessChoices(),
    harnessDefaultIndex(defaultHarness),
  )) as Harness;

  const extraMounts: Mount[] = [];
  while (await io.confirm("Add an extra mount?", false)) {
    const source = await io.prompt("  source");
    const target = await io.prompt("  target (under /sandbox/.openlock/ for copy types)");
    const type = (await io.select(
      "  type",
      [
        { label: "copy-once", value: "copy-once" },
        { label: "copy-refresh", value: "copy-refresh" },
        { label: "bind", value: "bind" },
        { label: "git-bundle", value: "git-bundle" },
      ],
      0,
    )) as Mount["type"];
    extraMounts.push({ source, target, type });
  }

  const env: Record<string, string> = {};
  while (await io.confirm("Add an env var?", false)) {
    const kv = await io.prompt("  KEY=VALUE");
    const eq = kv.indexOf("=");
    if (eq > 0) env[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }

  const argsRaw = await io.prompt("Extra harness args (space-separated, blank for none)", "");
  const args = argsRaw.trim().length > 0 ? argsRaw.trim().split(/\s+/) : [];

  return { harness, workdir, extraMounts, env, args };
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

  let opts: RenderInitOpts = {
    harness: args.harness,
    workdir: args.defaults?.workdir ?? "bind",
    extraMounts: [],
    env: {},
    args: [],
  };

  if (mode.kind === "fresh" && args.io.isTTY) {
    const choice = await args.io.select(
      "Configure how?",
      [
        { label: "Write sensible defaults; I'll edit .openlock/ by hand", value: "defaults" },
        { label: "Walk me through it", value: "guided" },
      ],
      0,
    );
    if (choice === "guided") {
      opts = await collectGuided(args.io, args.harness);
    }
  }

  const files = renderInitFiles(opts);

  if (mode.kind === "fresh" || mode.kind === "regenerate") {
    writeFiles(folder, files, ["config.yaml", "policy.yaml", "Containerfile"]);
    if (mode.kind === "regenerate") {
      args.io.write(
        "Regenerated from defaults (--force) — any prior hand-edits were overwritten.\n",
      );
    }
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

function defaultInitIO(): InitIO {
  const ask = async (q: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise<string>((res) =>
      rl.question(q, (a) => {
        rl.close();
        res(a);
      }),
    );
  };
  return {
    isTTY: Boolean(process.stdin.isTTY),
    write: (s) => process.stdout.write(s),
    async select(question, options, defIndex) {
      process.stderr.write(`${question}:\n`);
      for (const [i, o] of options.entries()) {
        process.stderr.write(`  ${i + 1}) ${o.label}\n`);
      }
      const a = (await ask(`> [${defIndex + 1}] `)).trim();
      const n = a === "" ? defIndex + 1 : Number.parseInt(a, 10);
      const idx = Number.isFinite(n) && n >= 1 && n <= options.length ? n - 1 : defIndex;
      return options[idx].value;
    },
    async confirm(question, def) {
      const a = (await ask(`${question} [${def ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
      if (a === "") return def;
      return a === "y" || a === "yes";
    },
    async prompt(question, def = "") {
      const a = (await ask(`${question}${def ? ` [${def}]` : ""}: `)).trim();
      return a === "" ? def : a;
    },
  };
}

export async function initCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("init", flagSchema, "[path]");
    return 0;
  }
  const projectPath = positionals[0] ?? process.cwd();
  const harness = resolveHarness({
    cliFlag: values.harness,
    env: process.env,
    readGlobal: readGlobalConfig,
  });
  return runInit({ projectPath, force: values.force === true, harness, io: defaultInitIO() });
}
