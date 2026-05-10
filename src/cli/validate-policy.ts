import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { formatErrors, validatePolicyFile } from "../validate-policy";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export function validatePolicyCmd(args: string[]): void {
  const { values, positionals } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("validate-policy", flagSchema, "<file.yaml>...");
    return;
  }
  const files = positionals;
  if (files.length === 0) {
    console.error("[validate-policy] no files specified");
    console.error("Usage: openlock validate-policy <file.yaml> [file2.yaml ...]");
    process.exit(1);
  }

  let hasErrors = false;
  for (const file of files) {
    const errors = validatePolicyFile(file);
    if (errors.length > 0) {
      hasErrors = true;
      console.error(formatErrors(errors, file));
    } else {
      console.log(`  ${file}: valid`);
    }
  }

  process.exit(hasErrors ? 1 : 0);
}
