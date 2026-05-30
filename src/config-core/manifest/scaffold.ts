import type { Mount } from "../types";

export interface ScaffoldManifestOpts {
  workdir: "bind" | "git-bundle";
  extraMounts?: Mount[];
  env?: Record<string, string>;
  args?: string[];
}

function workdirEntry(workdir: "bind" | "git-bundle"): string {
  const note =
    workdir === "bind"
      ? "live: host edits <-> sandbox; the agent can write the host repo"
      : "isolated snapshot + clone; required for --branch and sync-back";
  return [
    "  - source: .",
    "    target: /sandbox/repo",
    `    type: ${workdir}          # ${note}`,
  ].join("\n");
}

function workdirAlternative(workdir: "bind" | "git-bundle"): string {
  if (workdir === "bind") {
    return [
      "  # Isolated alternative (snapshot + clone; required for --branch and sync-back):",
      "  # - source: .",
      "  #   target: /sandbox/repo",
      "  #   type: git-bundle",
    ].join("\n");
  }
  return [
    "  # Live alternative (host edits <-> sandbox; the agent can write the host repo):",
    "  # - source: .",
    "  #   target: /sandbox/repo",
    "  #   type: bind",
  ].join("\n");
}

function renderMount(m: Mount): string {
  const lines = [`  - source: ${m.source}`, `    target: ${m.target}`, `    type: ${m.type}`];
  if (m.readOnly !== undefined) lines.push(`    readOnly: ${m.readOnly}`);
  return lines.join("\n");
}

const EXTRA_MOUNT_EXAMPLE = [
  "  # Extra mount example (a directory copied once into the sandbox):",
  "  # - source: ./assets",
  "  #   target: /sandbox/.openlock/assets",
  "  #   type: copy-once",
  "  # readOnly is only valid on type: bind, e.g.:",
  "  # - source: ./shared",
  "  #   target: /sandbox/.openlock/shared",
  "  #   type: bind",
  "  #   readOnly: true",
].join("\n");

function renderEnv(env: Record<string, string>): string {
  const keys = Object.keys(env);
  if (keys.length === 0) {
    return ["env: {}", '  # EXAMPLE_FLAG: "1"'].join("\n");
  }
  return ["env:", ...keys.map((k) => `  ${k}: ${JSON.stringify(env[k])}`)].join("\n");
}

function renderArgs(args: string[]): string {
  if (args.length === 0) {
    return ["args: []", "  # - --model", "  # - claude-sonnet-4-6"].join("\n");
  }
  return ["args:", ...args.map((a) => `  - ${JSON.stringify(a)}`)].join("\n");
}

export function scaffoldManifest(opts: ScaffoldManifestOpts): string {
  const extraMounts = opts.extraMounts ?? [];
  const mountLines = [
    "mounts:",
    workdirEntry(opts.workdir),
    workdirAlternative(opts.workdir),
    ...extraMounts.map(renderMount),
    EXTRA_MOUNT_EXAMPLE,
  ].join("\n");

  return `${[
    "# .openlock/config.yaml — your sandbox manifest. Edit freely.",
    "#",
    "# Supported keys: mounts, args, env. Anything else is rejected by",
    "# `openlock validate`. The workdir mount (target /sandbox/repo) is what",
    "# the agent works in.",
    "",
    mountLines,
    "",
    renderEnv(opts.env ?? {}),
    "",
    renderArgs(opts.args ?? []),
    "",
  ].join("\n")}`;
}
