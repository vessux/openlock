import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import type { GatewayStatus } from "../sandbox/ensure-gateway";
import { GATEWAY_NAME, gatewayStatus } from "../sandbox/ensure-gateway";
import { formatBytes, formatDuration } from "../sandbox/format";
import { classifyAll } from "../sandbox/session-ops";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

interface GatewayJson {
  name: string;
  state: "running" | "stopped";
  pid: number | null;
  rssKb: number | null;
  uptimeMs: number | null;
}

function gatewayJson(status: GatewayStatus): GatewayJson {
  return {
    name: GATEWAY_NAME,
    state: status.running ? "running" : "stopped",
    pid: status.pid,
    rssKb: status.rssKb ?? null,
    uptimeMs: status.uptimeMs ?? null,
  };
}

function renderGatewayHeader(status: GatewayStatus): string {
  if (!status.running) {
    return `GATEWAY        STATE    PID    RSS       UPTIME\n${GATEWAY_NAME.padEnd(10)}     stopped  -      -         -\n`;
  }
  const pid = status.pid === null ? "-" : String(status.pid);
  const rss = status.rssKb === undefined ? "-" : formatBytes(status.rssKb);
  const uptime = status.uptimeMs === undefined ? "-" : formatDuration(status.uptimeMs);
  return [
    "GATEWAY        STATE    PID    RSS       UPTIME",
    `${GATEWAY_NAME.padEnd(10)}     running  ${pid.padEnd(6)} ${rss.padEnd(9)} ${uptime}`,
    "",
  ].join("\n");
}

export async function listCmd(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("list", flagSchema, "");
    return 0;
  }
  const json = values.json === true;
  const gw = gatewayStatus();
  const rows = await classifyAll();

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          gateway: gatewayJson(gw),
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

  process.stdout.write(renderGatewayHeader(gw));

  if (rows.length === 0) {
    process.stdout.write("no sessions\n");
    return 0;
  }

  const headers = ["SESSION", "PATH", "CREATED", "STATE", "FLAG"];
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

  const reapable = rows.filter((r) => r.classification === "idle-stale").length;
  if (reapable > 0) {
    process.stdout.write(
      `\n${rows.length} sessions, ${reapable} reapable. Run \`openlock reap\`.\n`,
    );
  }
  return 0;
}

export const renderGatewayHeaderForTest = renderGatewayHeader;
export const gatewayJsonForTest = gatewayJson;
