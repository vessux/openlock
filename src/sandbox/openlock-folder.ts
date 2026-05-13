import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { defaultPolicyContent } from "./default-policies";
import { ALL_CAPS, type Cap, detectCaps } from "./detect-caps";
import { type Mount, parseMounts } from "./mounts";

const FOLDER_NAME = ".openlock";
const CONFIG_FILENAME = "config.yaml";
const POLICY_FILENAME = "policy.yaml";

export interface OpenlockFolderConfig {
  caps: Cap[];
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
}

export function configPath(folderPath: string): string {
  return join(folderPath, CONFIG_FILENAME);
}

export function policyPath(folderPath: string): string {
  return join(folderPath, POLICY_FILENAME);
}

function parseArgs(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new Error(`Invalid config.yaml: 'args' must be a list at ${where}`);
  for (const v of raw) {
    if (typeof v !== "string") {
      throw new Error(`Invalid config.yaml: 'args' must contain only strings at ${where}`);
    }
  }
  return raw as string[];
}

function parseEnv(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid config.yaml: 'env' must be a mapping at ${where}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`Invalid config.yaml: env value for '${k}' must be a string at ${where}`);
    }
    out[k] = v;
  }
  return out;
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

  if (doc.caps !== undefined && !Array.isArray(doc.caps)) {
    throw new Error(`Invalid config.yaml: 'caps' must be a list at ${path}`);
  }
  const rawCaps = Array.isArray(doc.caps) ? doc.caps : [];
  const caps: Cap[] = [];
  for (const c of rawCaps) {
    if (typeof c !== "string" || !ALL_CAPS.includes(c as Cap)) {
      throw new Error(`unknown cap '${String(c)}' in ${path}; allowed: ${ALL_CAPS.join(", ")}`);
    }
    caps.push(c as Cap);
  }

  const projectRoot = dirname(folderPath);
  const mounts = parseMounts(doc.mounts, projectRoot);
  const args = parseArgs(doc.args, path);
  const env = parseEnv(doc.env, path);

  return { caps, mounts, args, env };
}

export function writeConfig(folderPath: string, config: { caps: Cap[] }): void {
  mkdirSync(folderPath, { recursive: true });
  const doc = { caps: config.caps };
  writeFileSync(configPath(folderPath), yaml.dump(doc), "utf-8");
}

export function copyDefaultPolicy(folderPath: string, caps: Cap[]): void {
  mkdirSync(folderPath, { recursive: true });
  writeFileSync(policyPath(folderPath), defaultPolicyContent(caps), "utf-8");
}

type ResolveOrigin = "first-run" | "restored-config" | "restored-policy" | "existing";

export interface ResolveResult {
  caps: Cap[];
  policyPath: string;
  origin: ResolveOrigin;
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
}

function folderPathFor(projectPath: string): string {
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
    return {
      caps,
      policyPath: policyPath(folder),
      origin: "first-run",
      mounts: [],
      args: [],
      env: {},
    };
  }

  if (configExists && policyExists) {
    const cfg = readConfig(folder);
    return {
      caps: cfg.caps,
      policyPath: policyPath(folder),
      origin: "existing",
      mounts: cfg.mounts,
      args: cfg.args,
      env: cfg.env,
    };
  }

  if (!configExists && policyExists) {
    const caps = detectCaps(projectPath);
    writeConfig(folder, { caps });
    return {
      caps,
      policyPath: policyPath(folder),
      origin: "restored-config",
      mounts: [],
      args: [],
      env: {},
    };
  }

  // Remaining case: configExists && !policyExists.
  const cfg = readConfig(folder);
  copyDefaultPolicy(folder, cfg.caps);
  return {
    caps: cfg.caps,
    policyPath: policyPath(folder),
    origin: "restored-policy",
    mounts: cfg.mounts,
    args: cfg.args,
    env: cfg.env,
  };
}
