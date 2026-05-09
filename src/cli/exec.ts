import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { SANDBOX_PREFIX } from "../sandbox/constants";
import { inspectContainerState, execCmd as runExec, startContainer } from "../sandbox/container";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function execCmd(args: string[]): Promise<number> {
  const dashIdx = args.indexOf("--");
  const before = dashIdx === -1 ? args : args.slice(0, dashIdx);
  const after = dashIdx === -1 ? [] : args.slice(dashIdx + 1);
  const { values, positionals } = parseArgs({
    args: before,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp(
      "exec",
      flagSchema,
      "[name] -- <cmd...>",
      "Run a command inside the session container",
    );
    return 0;
  }
  if (after.length === 0) {
    console.error("usage: openlock exec [name] -- <cmd...>");
    return 1;
  }
  const name = await resolveSessionName(positionals[0], "exec into");
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
  return await runExec(containerName, after);
}
