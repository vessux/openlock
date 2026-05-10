import type { ParseArgsOptionsConfig } from "node:util";
import { COMMAND_DESCRIPTIONS, type CommandName } from "./_descriptions";

export function printCmdHelp(
  name: CommandName,
  schema: ParseArgsOptionsConfig,
  signature: string,
): void {
  console.log(`Usage: openlock ${name}${signature ? ` ${signature}` : ""}`);
  console.log("");
  console.log(COMMAND_DESCRIPTIONS[name]);
  const entries = Object.entries(schema);
  if (entries.length === 0) return;
  console.log("");
  console.log("Flags:");
  for (const [key, spec] of entries) {
    const short = spec.short ? `-${spec.short}, ` : "    ";
    const value = spec.type === "string" ? " <value>" : "";
    console.log(`  ${short}--${key}${value}`);
  }
}
