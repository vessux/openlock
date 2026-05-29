import { parseArgs } from "node:util";
import { type Runtime, resolveRuntime } from "../runtime";
import { computeBaseTag } from "../sandbox/ensure-base";
import { BASE_CONTAINERFILE } from "../sandbox/image-build";
import { defaultListTags, defaultRemove, pruneImages } from "../sandbox/prune-images";

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
    options: {
      legacy: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      "Usage: openlock prune-images [--legacy] [--dry-run]\n" +
        "  --legacy    remove pre-M5 images (openlock-core* prefix)\n" +
        "  --dry-run   print what would be removed, don't remove\n",
    );
    return 0;
  }

  const runtime = await resolveRuntime();
  const currentBaseTag = computeBaseTag(BASE_CONTAINERFILE);
  const { removed } = await pruneImages(
    {
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
  if (removed.length === 0) {
    console.log("nothing to prune");
  } else {
    console.log(`${verb} ${removed.length} image(s):`);
    for (const t of removed) console.log(`  ${t}`);
  }
  return 0;
}
