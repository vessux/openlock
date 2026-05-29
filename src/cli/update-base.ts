import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { GHCR_BASE_PREFIX, computeBaseTag } from "../sandbox/ensure-base";
import { BASE_CONTAINERFILE } from "../sandbox/image-build";
import { updateContainerfile } from "../sandbox/update-containerfile";

export async function updateBaseCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", default: process.cwd() },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log("Usage: openlock update-base [--project DIR]");
    return 0;
  }

  const project = values.project as string;
  const cfPath = join(project, ".openlock", "Containerfile");
  if (!existsSync(cfPath)) {
    console.error(`error: .openlock/Containerfile not found at ${cfPath}`);
    return 1;
  }
  const current = readFileSync(cfPath, "utf-8");

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
