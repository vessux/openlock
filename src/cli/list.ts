import { classifyAll } from "../sandbox/session-ops";

export async function listCmd(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const rows = await classifyAll();
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          sessions: rows.map((r) => ({
            name: r.meta.name,
            repoPath: r.meta.repoPath,
            createdAt: r.meta.createdAt,
            lastAttachedAt: r.meta.lastAttachedAt,
            containerState: r.state.containerState,
            classification: r.classification,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (rows.length === 0) {
    console.log("no sessions");
    return 0;
  }
  const headers = ["NAME", "PATH", "CREATED", "STATE", "FLAG"];
  const data = rows
    .sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt))
    .map((r) => [
      r.meta.name,
      r.meta.repoPath,
      r.meta.createdAt,
      r.state.containerState,
      r.classification === "idle-stale"
        ? "(idle, reapable)"
        : r.classification === "attached"
          ? "(attached)"
          : r.classification === "missing"
            ? "(no container)"
            : "",
    ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  process.stdout.write(`${[fmt(headers), ...data.map(fmt)].join("\n")}\n`);
  return 0;
}
