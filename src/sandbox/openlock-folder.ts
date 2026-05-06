import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { ALL_CAPS, detectCaps, type Cap } from "./detect-caps";
import { selectPolicy } from "./select-policy";

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
    if (typeof c !== "string" || !ALL_CAPS.includes(c as Cap)) {
      throw new Error(`unknown cap '${String(c)}' in ${path}; allowed: ${ALL_CAPS.join(", ")}`);
    }
    caps.push(c as Cap);
  }
  return { caps };
}

export function writeConfig(folderPath: string, config: OpenlockFolderConfig): void {
  mkdirSync(folderPath, { recursive: true });
  const doc = { caps: config.caps };
  writeFileSync(configPath(folderPath), yaml.dump(doc), "utf-8");
}

export function copyDefaultPolicy(folderPath: string, caps: Cap[]): void {
  mkdirSync(folderPath, { recursive: true });
  const source = selectPolicy(caps);
  copyFileSync(source, policyPath(folderPath));
}

export type ResolveOrigin = "first-run" | "restored-config" | "restored-policy" | "existing";

export interface ResolveResult {
  caps: Cap[];
  policyPath: string;
  origin: ResolveOrigin;
}

export function folderPathFor(projectPath: string): string {
  return join(projectPath, FOLDER_NAME);
}

export function resolveOpenlockFolder(projectPath: string): ResolveResult {
  const folder = folderPathFor(projectPath);
  const folderExists = existsSync(folder);
  const configExists = folderExists && existsSync(configPath(folder));
  const policyExists = folderExists && existsSync(policyPath(folder));

  if (!folderExists || (!configExists && !policyExists)) {
    const caps = detectCaps(projectPath);
    writeConfig(folder, { caps });
    copyDefaultPolicy(folder, caps);
    return { caps, policyPath: policyPath(folder), origin: "first-run" };
  }

  if (configExists && policyExists) {
    const cfg = readConfig(folder);
    return { caps: cfg.caps, policyPath: policyPath(folder), origin: "existing" };
  }

  throw new Error("not yet implemented: recovery paths");
}
