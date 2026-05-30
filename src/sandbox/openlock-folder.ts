import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { Mount } from "../config-core";
import { type ManifestConfig, parseManifest } from "../config-core";
import { defaultPolicyContent } from "./default-policies";
import { computeBaseTag, GHCR_BASE_PREFIX } from "./ensure-base";
import { resolveHarness } from "./harness";
import { BASE_CONTAINERFILE } from "./image-build";
import { seedContainerfile } from "./seed-containerfile";

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

function writeConfig(folderPath: string): void {
  mkdirSync(folderPath, { recursive: true });
  writeFileSync(configPath(folderPath), yaml.dump({}), "utf-8");
}

function copyDefaultPolicy(folderPath: string): void {
  mkdirSync(folderPath, { recursive: true });
  writeFileSync(policyPath(folderPath), defaultPolicyContent(), "utf-8");
}

function harnessForSeed(): "claude_code" | "opencode" {
  return resolveHarness({
    cliFlag: undefined,
    env: process.env,
    readGlobal: () => null,
  });
}

function writeSeedContainerfile(folderPath: string): void {
  mkdirSync(folderPath, { recursive: true });
  const baseHash = computeBaseTag(BASE_CONTAINERFILE).slice(GHCR_BASE_PREFIX.length);
  const content = seedContainerfile({
    harnesses: [harnessForSeed()],
    baseHash,
    baseContent: BASE_CONTAINERFILE,
  });
  writeFileSync(containerfilePath(folderPath), content, "utf-8");
}

type ResolveOrigin =
  | "first-run"
  | "restored-config"
  | "restored-policy"
  | "restored-containerfile"
  | "existing";

export interface ResolveResult {
  policyPath: string;
  origin: ResolveOrigin;
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
}

function folderPathFor(projectPath: string): string {
  return join(projectPath, FOLDER_NAME);
}

const EMPTY_CFG: OpenlockFolderConfig = { mounts: [], args: [], env: {} };

function buildResult(
  folder: string,
  origin: ResolveOrigin,
  cfg: OpenlockFolderConfig,
): ResolveResult {
  return {
    policyPath: policyPath(folder),
    origin,
    mounts: cfg.mounts,
    args: cfg.args,
    env: cfg.env,
  };
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

function isFirstRun(state: FolderState): boolean {
  return (
    !state.folderExists ||
    (!state.configExists && !state.policyExists && !state.containerfileExists)
  );
}

function resolveFirstRun(folder: string): ResolveResult {
  writeConfig(folder);
  copyDefaultPolicy(folder);
  writeSeedContainerfile(folder);
  return buildResult(folder, "first-run", EMPTY_CFG);
}

function resolveRestoredContainerfile(folder: string, state: FolderState): ResolveResult {
  writeSeedContainerfile(folder);
  if (!state.configExists) writeConfig(folder);
  if (!state.policyExists) copyDefaultPolicy(folder);
  const cfg = state.configExists ? readConfig(folder) : EMPTY_CFG;
  return buildResult(folder, "restored-containerfile", cfg);
}

function resolveRestoredConfig(folder: string, state: FolderState): ResolveResult {
  writeConfig(folder);
  if (!state.policyExists) copyDefaultPolicy(folder);
  return buildResult(folder, "restored-config", EMPTY_CFG);
}

function resolveRestoredPolicy(folder: string): ResolveResult {
  copyDefaultPolicy(folder);
  return buildResult(folder, "restored-policy", readConfig(folder));
}

export function resolveOpenlockFolder(projectPath: string): ResolveResult {
  const folder = folderPathFor(projectPath);
  const state = inspectFolder(folder);

  if (isFirstRun(state)) return resolveFirstRun(folder);

  if (state.configExists && state.policyExists && state.containerfileExists) {
    return buildResult(folder, "existing", readConfig(folder));
  }

  // Partial states — restore missing files. Priority: Containerfile first.
  if (!state.containerfileExists) return resolveRestoredContainerfile(folder, state);
  if (!state.configExists) return resolveRestoredConfig(folder, state);
  return resolveRestoredPolicy(folder);
}
