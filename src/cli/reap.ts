import { stopContainer } from "../sandbox/container";
import { classifyAll } from "../sandbox/session-ops";
import { SANDBOX_PREFIX } from "../sandbox/constants";

export async function reapCmd(_args: string[]): Promise<number> {
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
        console.error(`stop ${r.meta.name}: ${(e as Error).message}`)
      )
    ),
  );
  console.log(`reaped ${targets.length} idle session(s) (${Date.now() - start}ms)`);
  return 0;
}
