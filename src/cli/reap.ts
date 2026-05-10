import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { SANDBOX_PREFIX } from "../sandbox/constants";
import { stopContainer } from "../sandbox/container";
import { classifyAll } from "../sandbox/session-ops";
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
  const rows = await classifyAll();
  const targets = rows.filter((r) => r.classification === "idle-stale");
  if (targets.length === 0) {
    console.log("no idle sessions");
    return 0;
  }
  const start = Date.now();
  await Promise.all(
    targets.map((r) =>
      stopContainer(`${SANDBOX_PREFIX}${r.meta.name}`).catch((e) =>
        console.error(`stop ${r.meta.name}: ${(e as Error).message}`),
      ),
    ),
  );
  console.log(`reaped ${targets.length} idle session(s) (${Date.now() - start}ms)`);
  return 0;
}
