import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { computeBaseTag, GHCR_BASE_PREFIX } from "../sandbox/ensure-base";
import { BASE_CONTAINERFILE } from "../sandbox/image-build";
import { updateContainerfile } from "../sandbox/update-containerfile";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  project: { type: "string", default: process.cwd() },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function updateBaseCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: flagSchema,
    allowPositionals: false,
  });

  if (values.help) {
    printCmdHelp("update-base", flagSchema, "[--project DIR]");
    return 0;
  }

  const project = values.project as string;
  const cfPath = join(project, ".openlock", "Containerfile");
  let current: string;
  try {
    current = readFileSync(cfPath, "utf-8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.error(`error: .openlock/Containerfile not found at ${cfPath}`);
      return 1;
    }
    throw e;
  }

  const expectedTag = computeBaseTag(BASE_CONTAINERFILE);
  const newHash = expectedTag.slice(GHCR_BASE_PREFIX.length);

  let updated: string;
  try {
    updated = updateContainerfile(current, newHash, BASE_CONTAINERFILE);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }

  if (updated === current) {
    console.log(`already up to date (base ${newHash})`);
    return 0;
  }
  writeFileSync(cfPath, updated, "utf-8");
  console.log(`updated FROM to ${expectedTag}`);
  return 0;
}
