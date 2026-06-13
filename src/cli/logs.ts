import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { getSandboxState, execCmd as runExec } from "../sandbox/container";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  follow: { type: "boolean", short: "f" },
  lines: { type: "string", short: "n" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const DEFAULT_LINES = 200;

/**
 * Build the in-sandbox command that surfaces the openshell proxy's OCSF audit
 * log: per-request L7 allow/deny decisions (method, URL, policy, engine, and the
 * calling binary) written by the in-container supervisor/proxy — the data-plane
 * the host gateway log never shows. Date-stamped at
 * `/var/log/openshell.<date>.log` (root-owned, world-readable). The glob handles
 * date rollover; the `openshell-ocsf.<date>.log` sibling is intentionally NOT
 * matched (`openshell.*` requires a literal dot after `openshell`).
 */
export function buildProxyLogCmd(opts: { follow?: boolean; lines?: number } = {}): string[] {
  const n =
    typeof opts.lines === "number" && Number.isInteger(opts.lines) && opts.lines >= 0
      ? opts.lines
      : DEFAULT_LINES;
  const flags = opts.follow === true ? `-n ${n} -f` : `-n ${n}`;
  return [
    "sh",
    "-c",
    `tail ${flags} /var/log/openshell.*.log 2>/dev/null || echo "(no proxy log found at /var/log/openshell.*.log)"`,
  ];
}

export async function logsCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("logs", flagSchema, "[name]");
    return 0;
  }

  let lines = DEFAULT_LINES;
  if (typeof values.lines === "string") {
    const parsed = Number.parseInt(values.lines, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.error(`invalid --lines value: ${values.lines} (expected a non-negative integer)`);
      return 1;
    }
    lines = parsed;
  }

  const name = await resolveSessionName(positionals[0], "show proxy logs for");
  if (!name) return 1;

  const state = await getSandboxState(name);
  if (state === "missing") {
    console.error(`session ${name} has no container`);
    return 1;
  }
  if (state !== "running") {
    console.error(
      `session ${name} is not running (state: ${state}); start it (\`openlock sandbox\`) to read the proxy log`,
    );
    return 1;
  }

  return await runExec(name, buildProxyLogCmd({ follow: values.follow === true, lines }));
}
