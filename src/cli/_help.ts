import type { ParseArgsOptionsConfig } from "node:util";

export function printCmdHelp(
  name: string,
  schema: ParseArgsOptionsConfig,
  signature: string,
  summary: string,
): void {
  console.log(`Usage: openlock ${name}${signature ? ` ${signature}` : ""}`);
  console.log("");
  console.log(summary);
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
