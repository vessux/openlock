import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import type { ConfigFile, Issue, Severity } from "../config-core";
import { lintFolder } from "../config-core";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  offline: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const FILE_ORDER: ConfigFile[] = ["config.yaml", "policy.yaml"];
const SEVERITY_ORDER: Severity[] = ["error", "filesystem"];

function renderFile(file: ConfigFile, issues: Issue[]): string[] {
  const lines: string[] = [];
  if (issues.length === 0) {
    lines.push(`  ${file}: ok`);
    return lines;
  }
  lines.push(`  ${file}:`);
  for (const sev of SEVERITY_ORDER) {
    for (const issue of issues.filter((i) => i.severity === sev)) {
      const loc = issue.path ? `${issue.path}: ` : "";
      const tag = sev === "filesystem" ? "[fs] " : "";
      lines.push(`    ${tag}${loc}${issue.message}`);
      if (issue.fix) lines.push(`      fix: ${issue.fix}`);
    }
  }
  return lines;
}

export function renderIssues(issues: Issue[]): string[] {
  const lines: string[] = [];
  for (const file of FILE_ORDER) {
    const forFile = issues.filter((i) => i.file === file);
    lines.push(...renderFile(file, forFile));
  }
  return lines;
}

export function validateCmd(args: string[]): void {
  const { values, positionals } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("validate", flagSchema, "[path]");
    return;
  }
  const projectDir = positionals[0] ?? process.cwd();
  const issues = lintFolder(projectDir, { offline: values.offline === true });
  for (const line of renderIssues(issues)) console.log(line);
  const blocking = issues.some((i) => i.severity === "error" || i.severity === "filesystem");
  process.exit(blocking ? 1 : 0);
}
