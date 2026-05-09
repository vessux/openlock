import type { ParseArgsOptionsConfig } from "node:util";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;
