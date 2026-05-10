import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export function gatewayCmd(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("gateway", flagSchema, "<start|stop|status>");
    return;
  }
  const sub = positionals[0];

  switch (sub) {
    case "start":
      import("../sandbox/ensure-gateway").then(({ startGateway }) => startGateway());
      return;
    case "stop":
      import("../sandbox/ensure-gateway").then(({ stopGateway }) => stopGateway());
      return;
    case "status":
      import("../sandbox/ensure-gateway").then(({ gatewayStatus }) => {
        const status = gatewayStatus();
        console.log(JSON.stringify(status));
      });
      return;
    default:
      console.error("Usage: openlock gateway <start|stop|status>");
      process.exit(1);
  }
}
