import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  policy: { type: "string" },
  harness: { type: "string" },
  provider: { type: "string" },
  branch: { type: "string", short: "b" },
  "no-attach": { type: "boolean" },
  "debug-egress": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export function sandboxCmd(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("sandbox", flagSchema, "[path]");
    return;
  }
  const path = positionals[0] ?? process.cwd();

  import("../sandbox/session").then(({ runSandbox }) =>
    runSandbox({
      path,
      policy: values.policy,
      harness: values.harness,
      provider: values.provider,
      branch: values.branch,
      noAttach: values["no-attach"] === true,
      debugEgress: values["debug-egress"] === true,
    }),
  );
}
