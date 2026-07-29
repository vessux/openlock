import type { Harness } from "./harness";
import { HARNESS_VERSIONS, harnessInstallLine } from "./harness-versions";
import { HARNESS_SENTINEL } from "./update-containerfile";

interface HarnessVersionUpdate {
  harness: Harness;
  /** False when this harness's install line isn't present in the file at all
   * (e.g. the project only uses the other harness). */
  found: boolean;
  /** Version currently installed, if `found`. */
  previousVersion?: string;
  /** Version this run resolved as the target. */
  newVersion: string;
  /** True iff `found` and `previousVersion !== newVersion`. */
  changed: boolean;
}

export interface UpdateHarnessVersionsResult {
  content: string;
  updates: HarnessVersionUpdate[];
}

/** Escapes a string for embedding as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which harnesses have a recognizable `RUN npm install -g <pkg>@<version>`
 * line anywhere in the file (sentinel or no sentinel — presence detection is
 * independent of the block structure `updateHarnessVersions` requires). Used
 * by the CLI to resolve versions only for harnesses actually in use. */
export function harnessesPresentIn(content: string): Harness[] {
  return (Object.keys(HARNESS_VERSIONS) as Harness[]).filter((h) => {
    const pkg = HARNESS_VERSIONS[h].package;
    const re = new RegExp(`^RUN npm install -g ${escapeRegExp(pkg)}@\\S+$`, "m");
    return re.test(content);
  });
}

/**
 * Rewrites the `RUN npm install -g <pkg>@<version>` line for each harness in
 * `targetVersions` to the given version, touching only lines inside the
 * harness block (after {@link HARNESS_SENTINEL}) and only lines whose package
 * matches a known harness package from {@link HARNESS_VERSIONS}. Everything
 * else — the base-image header, ARGs, comments, a user's own `npm install`
 * line for an unrelated tool — is byte-preserved.
 *
 * Deliberately does NOT go through `extractHarnessBlock`/`updateContainerfile`
 * (./update-containerfile): those regenerate the entire header around the
 * extracted block, which is right for `update-base` (which intentionally
 * re-embeds the current base-image reference) but would blow away arbitrary
 * user edits to that section here — this function only ever touches the
 * matched install lines.
 */
export function updateHarnessVersions(
  current: string,
  targetVersions: Partial<Record<Harness, string>>,
): UpdateHarnessVersionsResult {
  const sentinelIdx = current.indexOf(HARNESS_SENTINEL);
  if (sentinelIdx < 0) {
    throw new Error(
      "update-harness: couldn't find harness sentinel; refusing to auto-update. " +
        "Edit the harness install line(s) manually.",
    );
  }
  const head = current.slice(0, sentinelIdx + HARNESS_SENTINEL.length);
  let tail = current.slice(sentinelIdx + HARNESS_SENTINEL.length);

  const updates: HarnessVersionUpdate[] = [];
  for (const [harness, newVersion] of Object.entries(targetVersions) as [Harness, string][]) {
    const pkg = HARNESS_VERSIONS[harness].package;
    const lineRe = new RegExp(`^RUN npm install -g ${escapeRegExp(pkg)}@(\\S+)$`, "m");
    const match = lineRe.exec(tail);
    if (!match) {
      updates.push({ harness, found: false, newVersion, changed: false });
      continue;
    }
    const previousVersion = match[1];
    const changed = previousVersion !== newVersion;
    if (changed) {
      tail = tail.replace(lineRe, harnessInstallLine(harness, newVersion));
    }
    updates.push({ harness, found: true, previousVersion, newVersion, changed });
  }

  return { content: head + tail, updates };
}
