import { cleanSession, classifyAll } from "../sandbox/session-ops";
import { resolveSessionName } from "./_resolve";

function copyDirArg(args: string[]): string | undefined {
  const i = args.indexOf("--copy");
  if (i === -1) return undefined;
  return args[i + 1];
}

export async function cleanCmd(args: string[]): Promise<number> {
  const copyDir = copyDirArg(args);
  if (args.includes("--all") || args.includes("--stale")) {
    const stale = args.includes("--stale");
    const rows = await classifyAll();
    const targets = rows.filter((r) =>
      stale ? (r.classification === "exited" || r.classification === "missing")
            : true
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
  const positional = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--copy");
  const name = await resolveSessionName(positional, "clean");
  if (!name) return 1;
  try {
    await cleanSession(name, { copyDir });
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
