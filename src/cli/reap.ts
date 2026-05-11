import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { reapIdleStaleSessions } from "../sandbox/session-ops";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function reapCmd(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("reap", flagSchema, "");
    return 0;
  }
  const { reaped, durationMs } = await reapIdleStaleSessions();
  if (reaped.length === 0) {
    console.log("no idle sessions");
    return 0;
  }
  console.log(`reaped ${reaped.length} idle session(s) (${durationMs}ms)`);
  return 0;
}
