import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  policy: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export function sandboxCmd(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp(
      "sandbox",
      flagSchema,
      "[path]",
      "Create or resume a sandbox session (path defaults to cwd; runs preflight + auto-inits the repo)",
    );
    return;
  }
  const path = positionals[0] ?? process.cwd();

  import("../sandbox/session").then(({ runSandbox }) =>
    runSandbox({
      path,
      policy: values.policy,
    }),
  );
}
