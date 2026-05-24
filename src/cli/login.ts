import type { ParseArgsOptionsConfig } from "node:util";

export const flagSchema = {
  provider: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;
