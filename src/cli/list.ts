import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import type { GatewayStatus } from "../sandbox/ensure-gateway";
import { GATEWAY_NAME, gatewayStatus } from "../sandbox/ensure-gateway";
import { formatBytes, formatDuration } from "../sandbox/format";
import type { Classification } from "../sandbox/reap";
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
  // openlock-ox1: the active driver is otherwise invisible in every status
  // surface, which is half the reason a driver mismatch went unnoticed.
  // null when not running, or when running but the driver wasn't recorded
  // (legacy gateway, pre-dating this field).
  driver: string | null;
}

function gatewayJson(status: GatewayStatus): GatewayJson {
  return {
    name: GATEWAY_NAME,
    state: status.running ? "running" : "stopped",
    pid: status.pid,
    rssKb: status.rssKb ?? null,
    uptimeMs: status.uptimeMs ?? null,
    driver: status.driver ?? null,
  };
}

function renderGatewayHeader(status: GatewayStatus): string {
  if (!status.running) {
    return `GATEWAY        STATE    PID    RSS       UPTIME    DRIVER\n${GATEWAY_NAME.padEnd(10)}     stopped  -      -         -         -\n`;
  }
  const pid = status.pid === null ? "-" : String(status.pid);
  const rss = status.rssKb === undefined ? "-" : formatBytes(status.rssKb);
  const uptime = status.uptimeMs === undefined ? "-" : formatDuration(status.uptimeMs);
  const driver = status.driver ?? "-";
  return [
    "GATEWAY        STATE    PID    RSS       UPTIME    DRIVER",
    `${GATEWAY_NAME.padEnd(10)}     running  ${pid.padEnd(6)} ${rss.padEnd(9)} ${uptime.padEnd(9)} ${driver}`,
    "",
  ].join("\n");
}

// openlock-vtl: exhaustive switch (not the previous inline ternary chain) so
// widening Classification again is a compile error here, not a silent
// fall-through to the empty-string default — exactly the "missed case"
// failure mode a state union widening invites. "unreachable" must read
// honestly rather than being folded into "(no container)" (which is what
// "missing" means: the gateway said this session doesn't exist) or silently
// showing nothing.
export function classificationFlag(classification: Classification): string {
  switch (classification) {
    case "idle-stale":
      return "(idle, reapable)";
    case "attached":
      return "(attached)";
    case "missing":
      return "(no container)";
    case "unreachable":
      return "(gateway unreachable)";
    case "idle-recent":
    case "exited":
      return "";
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
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
      classificationFlag(r.classification),
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
