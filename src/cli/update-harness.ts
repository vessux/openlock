import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import type { Harness } from "../sandbox/harness";
import type { FetchDistTags } from "../sandbox/resolve-harness-version";
import { resolveHarnessVersion } from "../sandbox/resolve-harness-version";
import { HARNESS_SENTINEL } from "../sandbox/update-containerfile";
import { harnessesPresentIn, updateHarnessVersions } from "../sandbox/update-harness-versions";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  project: { type: "string", default: process.cwd() },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export interface UpdateHarnessCmdDeps {
  fetchDistTags?: FetchDistTags;
}

/**
 * Prints one line per harness update (changed / already-current / left
 * untouched) and reports whether anything actually changed.
 *
 * `present` is detected by scanning the WHOLE file (harnessesPresentIn), but
 * updateHarnessVersions only ever rewrites lines after HARNESS_SENTINEL. A
 * harness whose install line sits ABOVE the sentinel is therefore "present"
 * but comes back `found: false` here (never even looked at) — that case gets
 * its own warning rather than silently vanishing from the output, and
 * `anyOutsideBlock` lets the caller suppress a bare "already up to date"
 * claim that would otherwise be false.
 */
function reportUpdates(updates: ReturnType<typeof updateHarnessVersions>["updates"]): {
  anyChanged: boolean;
  anyOutsideBlock: boolean;
} {
  let anyChanged = false;
  let anyOutsideBlock = false;
  for (const u of updates) {
    if (u.changed) {
      console.log(`${u.harness}: ${u.previousVersion} -> ${u.newVersion}`);
      anyChanged = true;
    } else if (u.found) {
      console.log(`${u.harness}: already up to date (${u.newVersion})`);
    } else {
      console.warn(
        `warning: ${u.harness}'s npm install line was found outside the harness block ` +
          `(the section after "${HARNESS_SENTINEL}" in .openlock/Containerfile) and was ` +
          `left untouched. Edit it manually to pin ${u.harness} at ${u.newVersion}.`,
      );
      anyOutsideBlock = true;
    }
  }
  return { anyChanged, anyOutsideBlock };
}

export async function updateHarnessCmd(
  argv: string[],
  deps?: UpdateHarnessCmdDeps,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: flagSchema,
    allowPositionals: false,
  });

  if (values.help) {
    printCmdHelp("update-harness", flagSchema, "[--project DIR]");
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

  const present = harnessesPresentIn(current);
  if (present.length === 0) {
    console.log("no known harness installs found in .openlock/Containerfile; nothing to update");
    return 0;
  }

  const targetVersions: Partial<Record<Harness, string>> = {};
  for (const harness of present) {
    try {
      targetVersions[harness] = await resolveHarnessVersion(harness, deps?.fetchDistTags);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      return 1;
    }
  }

  let updated: string;
  let updates: ReturnType<typeof updateHarnessVersions>["updates"];
  try {
    ({ content: updated, updates } = updateHarnessVersions(current, targetVersions));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }

  const { anyChanged, anyOutsideBlock } = reportUpdates(updates);

  if (!anyChanged) {
    if (!anyOutsideBlock) {
      console.log("already up to date");
    }
    return 0;
  }

  writeFileSync(cfPath, updated, "utf-8");
  // Verified against ensure-sandbox.ts/session.ts + drift.ts: the sandbox
  // image tag is a content hash of the whole Containerfile (image-build.ts
  // computeImageTag), so this edit gets a fresh image on the next `openlock
  // sandbox` create. On reattach, drift.ts only detects this for a session
  // that recorded a build-inputs hash at create time (buildInputsHash, added
  // PR #99, 2026-07-25) — decideReattachAction's `storedHash === undefined`
  // branch treats an older session (predating that field) as "can't compare"
  // and proceeds WITHOUT a prompt, by design (a false alarm on every legacy
  // session's first reattach would be worse). So a harness bump can be kept
  // silently stale on such a session; `--rebuild` is the only route that's
  // unconditional, since it's honored before any drift comparison.
  console.log(
    "Run `openlock sandbox` to build the new image. A running session normally prompts to " +
      "rebuild on reattach; `openlock sandbox --rebuild` forces it regardless.",
  );
  return 0;
}
