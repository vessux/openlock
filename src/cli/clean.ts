import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { classifyAll, cleanSession } from "../sandbox/session-ops";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  copy: { type: "string" },
  all: { type: "boolean" },
  stale: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function cleanCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("clean", flagSchema, "[name]");
    return 0;
  }
  const copyDir = values.copy;
  if (values.all === true || values.stale === true) {
    const stale = values.stale === true;
    const rows = await classifyAll();
    const targets = rows.filter((r) =>
      stale ? r.classification === "exited" || r.classification === "missing" : true,
    );
    for (const r of targets) {
      try {
        await cleanSession(r.meta.name, { copyDir });
      } catch (e) {
        console.error(`clean ${r.meta.name}: ${(e as Error).message}`);
      }
    }
    console.log(`cleaned ${targets.length} session(s)`);
    return 0;
  }
  const name = await resolveSessionName(positionals[0], "clean");
  if (!name) return 1;
  try {
    await cleanSession(name, { copyDir });
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
