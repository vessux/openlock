import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { loadConfig, resolveEndpoint } from "../cred-refresh/config";
import { runRefreshLoop } from "../cred-refresh/loop";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  config: { type: "string", short: "c" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export function credRefreshCmd(args: string[]): void {
  const { values } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("cred-refresh", flagSchema, "", "Start the credential refresh service");
    return;
  }
  const configPath = values.config ?? join(process.cwd(), "providers", "refresh.yaml");

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    console.error(`[cred-refresh] ${(e as Error).message}`);
    process.exit(1);
  }

  const endpoint = resolveEndpoint(config.endpoint);
  console.log(`[cred-refresh] endpoint: ${endpoint}`);
  console.log(`[cred-refresh] config: ${configPath}`);

  runRefreshLoop(config);
}
