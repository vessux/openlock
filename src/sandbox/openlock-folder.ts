import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import type { Cap } from "./detect-caps";

const VALID_CAPS: ReadonlyArray<Cap> = ["js", "py"];

export const FOLDER_NAME = ".openlock";
export const CONFIG_FILENAME = "config.yaml";
export const POLICY_FILENAME = "policy.yaml";

export interface OpenlockFolderConfig {
  caps: Cap[];
}

export function configPath(folderPath: string): string {
  return join(folderPath, CONFIG_FILENAME);
}

export function policyPath(folderPath: string): string {
  return join(folderPath, POLICY_FILENAME);
}

export function readConfig(folderPath: string): OpenlockFolderConfig {
  const path = configPath(folderPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`config.yaml not found at ${path}`);
  }

  const doc = (yaml.load(raw) ?? {}) as Record<string, unknown>;
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`Invalid config.yaml: expected mapping at ${path}`);
  }

  const rawCaps = Array.isArray(doc.caps) ? doc.caps : [];
  const caps: Cap[] = [];
  for (const c of rawCaps) {
    if (typeof c !== "string" || !VALID_CAPS.includes(c as Cap)) {
      throw new Error(`unknown cap '${String(c)}' in ${path}; allowed: ${VALID_CAPS.join(", ")}`);
    }
    caps.push(c as Cap);
  }
  return { caps };
}
