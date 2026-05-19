import { existsSync, readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { globalConfigPath } from "./paths";
import { type GlobalConfig, validateAndShape } from "./schema";

export type { GlobalConfig } from "./schema";

export function parseGlobalConfig(text: string, source: string): GlobalConfig {
  const raw = yamlLoad(text);
  return validateAndShape(raw, source);
}

export function readGlobalConfigFrom(path: string): GlobalConfig | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  return parseGlobalConfig(text, path);
}

export function readGlobalConfig(): GlobalConfig | null {
  return readGlobalConfigFrom(globalConfigPath());
}
