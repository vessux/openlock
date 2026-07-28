import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import type { ConfigFile, Issue, Severity } from "../config-core";
import { gitignoreCoversLocalConfig, lintFolder } from "../config-core";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  offline: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const BASE_FILE_ORDER: ConfigFile[] = ["config.yaml", "policy.yaml"];
const SEVERITY_ORDER: Severity[] = ["error", "filesystem", "warning"];
// Non-"error" severities get a bracketed tag prefix; "error" (the common
// case) stays untagged to match the pre-existing output shape.
const SEVERITY_TAGS: Partial<Record<Severity, string>> = {
  filesystem: "[fs] ",
  warning: "[warn] ",
};

function renderIssue(issue: Issue): string[] {
  const loc = issue.path ? `${issue.path}: ` : "";
  const tag = SEVERITY_TAGS[issue.severity] ?? "";
  const lines = [`    ${tag}${loc}${issue.message}`];
  if (issue.fix) lines.push(`      fix: ${issue.fix}`);
  return lines;
}

function renderFile(file: ConfigFile, issues: Issue[]): string[] {
  if (issues.length === 0) return [`  ${file}: ok`];
  const lines: string[] = [`  ${file}:`];
  for (const sev of SEVERITY_ORDER) {
    for (const issue of issues.filter((i) => i.severity === sev)) lines.push(...renderIssue(issue));
  }
  return lines;
}

export function renderIssues(issues: Issue[], files: ConfigFile[] = BASE_FILE_ORDER): string[] {
  const lines: string[] = [];
  for (const file of files) {
    const forFile = issues.filter((i) => i.file === file);
    lines.push(...renderFile(file, forFile));
  }
  return lines;
}

export function summaryLine(issues: Issue[], files: ConfigFile[] = BASE_FILE_ORDER): string {
  const parts = files.map((file) => {
    const n = issues.filter((i) => i.file === file).length;
    return n === 0 ? `${file}: ok` : `${file}: ${n} issue${n === 1 ? "" : "s"}`;
  });
  return parts.join(" · ");
}

export function validateCmd(args: string[]): void {
  const { values, positionals } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("validate", flagSchema, "[path]");
    return;
  }
  const projectDir = positionals[0] ?? process.cwd();
  const folder = join(projectDir, ".openlock");
  const localExists = existsSync(join(folder, "config.local.yaml"));
  const files: ConfigFile[] = localExists
    ? ["config.yaml", "config.local.yaml", "policy.yaml"]
    : BASE_FILE_ORDER;
  const issues = lintFolder(projectDir, { offline: values.offline === true });
  for (const line of renderIssues(issues, files)) console.log(line);
  console.log(summaryLine(issues, files));
  if (localExists) {
    const giPath = join(folder, ".gitignore");
    const gi = existsSync(giPath) ? readFileSync(giPath, "utf-8") : null;
    if (!gitignoreCoversLocalConfig(gi)) {
      console.log(
        "note: config.local.yaml is not covered by .openlock/.gitignore — add `config.local.yaml` so personal overrides aren't committed.",
      );
    }
  }
  const blocking = issues.some((i) => i.severity === "error" || i.severity === "filesystem");
  process.exit(blocking ? 1 : 0);
}
