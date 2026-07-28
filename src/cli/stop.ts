import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { classifyAll, stopSession } from "../sandbox/session-ops";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  all: { type: "boolean" },
  stale: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function stopCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("stop", flagSchema, "[name]");
    return 0;
  }
  if (values.all === true || values.stale === true) {
    const stale = values.stale === true;
    const rows = await classifyAll();
    // openlock-vtl audit: safe by construction against classification
    // "unreachable" without any extra check needed here — --stale only ever
    // targets "idle-stale" (which requires containerState === "running" to
    // be reached at all, see classifySession) and --all's raw-state check
    // requires containerState === "running" directly; "unreachable" can
    // never satisfy either, so a session we couldn't confirm the state of is
    // never targeted.
    const targets = rows.filter((r) =>
      stale
        ? r.classification === "idle-stale"
        : r.state.containerState === "running" && r.classification !== "attached",
    );
    const skippedAttached = rows.filter((r) => !stale && r.classification === "attached");
    if (skippedAttached.length > 0) {
      console.warn(
        `skipped ${skippedAttached.length} attached session(s) (use openlock stop <name> to force)`,
      );
    }
    await Promise.all(
      targets.map((r) =>
        stopSession(r.meta.name).catch((e) =>
          console.error(`stop ${r.meta.name}: ${(e as Error).message}`),
        ),
      ),
    );
    console.log(`stopped ${targets.length} session(s)`);
    return 0;
  }
  const name = await resolveSessionName(positionals[0], "stop");
  if (!name) return 1;
  try {
    await stopSession(name);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
