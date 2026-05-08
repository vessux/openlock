import { classifyAll, stopSession } from "../sandbox/session-ops";
import { resolveSessionName } from "./_resolve";

export async function stopCmd(args: string[]): Promise<number> {
  if (args.includes("--all") || args.includes("--stale")) {
    const stale = args.includes("--stale");
    const rows = await classifyAll();
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
  const positional = args.find((a) => !a.startsWith("--"));
  const name = await resolveSessionName(positional, "stop");
  if (!name) return 1;
  try {
    await stopSession(name);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
