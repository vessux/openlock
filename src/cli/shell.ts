import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { SANDBOX_PREFIX } from "../sandbox/constants";
import { execBash, inspectContainerState, startContainer } from "../sandbox/container";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function shellCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("shell", flagSchema, "[name]", "Open bash inside the session container");
    return 0;
  }
  const name = await resolveSessionName(positionals[0], "shell into");
  if (!name) return 1;
  const containerName = `${SANDBOX_PREFIX}${name}`;
  const state = await inspectContainerState(containerName);
  if (state === "missing") {
    console.error(`session ${name} has no container`);
    return 1;
  }
  if (state === "exited") {
    await startContainer(containerName);
  }
  return await execBash(containerName);
}
