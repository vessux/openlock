import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { getSandboxState, execCmd as runExec } from "../sandbox/container";
// buildProxyLogCmd lives in sandbox/ (not here) so it's reusable by the
// TLS-fallback health check (session.ts/tls-state.ts) without that code
// reaching into cli/ — sandbox/ code must not import from cli/.
import { buildProxyLogCmd } from "../sandbox/proxy-log";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export { buildProxyLogCmd };

export const flagSchema = {
  follow: { type: "boolean", short: "f" },
  lines: { type: "string", short: "n" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const DEFAULT_LINES = 200;

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
