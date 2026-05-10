import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { statusSession } from "../sandbox/session-ops";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function statusCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("status", flagSchema, "[name]");
    return 0;
  }
  const name = await resolveSessionName(positionals[0], "show status");
  if (!name) return 1;
  try {
    const r = await statusSession(name);
    process.stdout.write(
      `${JSON.stringify(
        {
          name: r.meta.name,
          meta: r.meta,
          containerState: r.state.containerState,
          pidAlive: r.state.pidAlive,
          classification: r.classification,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
