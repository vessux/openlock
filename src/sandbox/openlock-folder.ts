import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { Mount } from "../config-core";
import { type ManifestConfig, parseManifest } from "../config-core";

const FOLDER_NAME = ".openlock";
const CONFIG_FILENAME = "config.yaml";
const POLICY_FILENAME = "policy.yaml";
const CONTAINERFILE_FILENAME = "Containerfile";

type OpenlockFolderConfig = ManifestConfig;

function configPath(folderPath: string): string {
  return join(folderPath, CONFIG_FILENAME);
}
function policyPath(folderPath: string): string {
  return join(folderPath, POLICY_FILENAME);
}
function containerfilePath(folderPath: string): string {
  return join(folderPath, CONTAINERFILE_FILENAME);
}

function readConfig(folderPath: string): OpenlockFolderConfig {
  const path = configPath(folderPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`config.yaml not found at ${path}`);
  }
  const doc = yaml.load(raw) ?? {};
  return parseManifest(doc, dirname(folderPath));
}

export interface ResolveResult {
  policyPath: string;
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
}

function folderPathFor(projectPath: string): string {
  return join(projectPath, FOLDER_NAME);
}

interface FolderState {
  folderExists: boolean;
  configExists: boolean;
  policyExists: boolean;
  containerfileExists: boolean;
}

function inspectFolder(folder: string): FolderState {
  const folderExists = existsSync(folder);
  return {
    folderExists,
    configExists: folderExists && existsSync(configPath(folder)),
    policyExists: folderExists && existsSync(policyPath(folder)),
    containerfileExists: folderExists && existsSync(containerfilePath(folder)),
  };
}

export function resolveOpenlockFolder(projectPath: string): ResolveResult {
  const folder = folderPathFor(projectPath);
  const state = inspectFolder(folder);
  if (state.configExists && state.policyExists && state.containerfileExists) {
    const cfg = readConfig(folder);
    return { policyPath: policyPath(folder), mounts: cfg.mounts, args: cfg.args, env: cfg.env };
  }
  const missing = [
    state.configExists ? null : "config.yaml",
    state.policyExists ? null : "policy.yaml",
    state.containerfileExists ? null : "Containerfile",
  ].filter((x): x is string => x !== null);
  const what = state.folderExists ? `missing ${missing.join(", ")}` : "no .openlock/ directory";
  throw new Error(
    `.openlock/ is incomplete (${what}) in ${projectPath}. Run \`openlock init\` to scaffold it.`,
  );
}
