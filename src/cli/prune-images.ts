import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { type Runtime, resolveRuntime } from "../runtime";
import { computeBaseTag } from "../sandbox/ensure-base";
import { BASE_CONTAINERFILE } from "../sandbox/image-build";
import { defaultListTags, defaultRemove, pruneImages } from "../sandbox/prune-images";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  legacy: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

async function listInUseImages(runtime: Runtime): Promise<Set<string>> {
  const proc = Bun.spawn([runtime, "ps", "-a", "--format", "{{.Image}}"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return new Set(
    out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export async function pruneImagesCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: flagSchema,
    allowPositionals: false,
  });

  if (values.help) {
    printCmdHelp("prune-images", flagSchema, "[--legacy] [--dry-run]");
    return 0;
  }

  const runtime = await resolveRuntime();
  const currentBaseTag = computeBaseTag(BASE_CONTAINERFILE);
  const { removed, failed } = await pruneImages(
    {
      runtime,
      legacy: values.legacy as boolean,
      currentBaseTag,
      dryRun: values["dry-run"] as boolean,
    },
    {
      listTags: defaultListTags,
      remove: defaultRemove,
      listActiveSandboxTags: () => listInUseImages(runtime),
    },
  );

  const verb = values["dry-run"] ? "would remove" : "removed";
  if (removed.length === 0 && failed.length === 0) {
    console.log("nothing to prune");
  } else if (removed.length > 0) {
    console.log(`${verb} ${removed.length} image(s):`);
    for (const t of removed) console.log(`  ${t}`);
  }
  if (failed.length > 0) {
    console.error(
      `failed to remove ${failed.length} image(s) (still in use by a stopped container? run \`openlock clean\` first):`,
    );
    for (const t of failed) console.error(`  ${t}`);
    return 1;
  }
  return 0;
}
