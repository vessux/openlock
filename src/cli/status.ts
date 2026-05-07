import { statusSession } from "../sandbox/session-ops";
import { resolveSessionName } from "./_resolve";

export async function statusCmd(args: string[]): Promise<number> {
  const positional = args.find((a) => !a.startsWith("--"));
  const name = await resolveSessionName(positional, "show status");
  if (!name) return 1;
  try {
    const r = await statusSession(name);
    process.stdout.write(JSON.stringify({
      name: r.meta.name,
      meta: r.meta,
      containerState: r.state.containerState,
      pidAlive: r.state.pidAlive,
      classification: r.classification,
    }, null, 2) + "\n");
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
