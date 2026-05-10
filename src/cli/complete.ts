import type { ParseArgsOptionsConfig } from "node:util";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function completeCmd(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    printCmdHelp("complete", flagSchema, "<bash|zsh|fish>");
    return 0;
  }
  const shell = args[0];
  switch (shell) {
    case "bash": {
      const { completionScript } = await import("./completions/bash");
      process.stdout.write(completionScript());
      return 0;
    }
    case "zsh": {
      const { completionScript } = await import("./completions/zsh");
      process.stdout.write(completionScript());
      return 0;
    }
    case "fish": {
      const { completionScript } = await import("./completions/fish");
      process.stdout.write(completionScript());
      return 0;
    }
    default:
      console.error("Usage: openlock complete <bash|zsh|fish>");
      return 1;
  }
}
