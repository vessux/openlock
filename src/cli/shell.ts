import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { execBash, getSandboxState } from "../sandbox/container";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function shellCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("shell", flagSchema, "[name]");
    return 0;
  }
  const name = await resolveSessionName(positionals[0], "shell into");
  if (!name) return 1;
  const state = await getSandboxState(name);
  if (state === "missing") {
    console.error(`session ${name} has no container`);
    return 1;
  }
  return await execBash(name);
}
