import type { ParseArgsOptionsConfig } from "node:util";

export interface FlagInfo {
  long: string;
  short: string | null;
  takesValue: boolean;
}

export function flagsOf(schema: ParseArgsOptionsConfig): FlagInfo[] {
  return Object.entries(schema).map(([key, spec]) => ({
    long: `--${key}`,
    short: spec.short ? `-${spec.short}` : null,
    takesValue: spec.type === "string",
  }));
}
