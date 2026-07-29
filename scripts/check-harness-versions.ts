import type { Harness } from "../src/sandbox/harness";
import { HARNESS_VERSIONS } from "../src/sandbox/harness-versions";
import { resolveHarnessVersion } from "../src/sandbox/resolve-harness-version";

// Maintainer "am I behind?" check: hits the real npm registry, so it is
// deliberately NOT wired into `bun run test` or any CI workflow — see
// `bun run harness:check` in package.json. Bumping the pin itself is a
// separate, live-smoke-gated change; this only reports drift.
//
// Exit codes are deliberately distinct: "the check didn't run" (registry
// unreachable, dist-tag vanished) must never look like "the check ran and
// found you're behind" — a maintainer reading exit 1 should be able to trust
// that every harness was actually compared.
async function main(): Promise<number> {
  let drifted = false;
  let failed = false;
  for (const harness of Object.keys(HARNESS_VERSIONS) as Harness[]) {
    const pinned = HARNESS_VERSIONS[harness].version;
    let resolved: string;
    try {
      resolved = await resolveHarnessVersion(harness);
    } catch (e) {
      console.error(
        `${harness}: check FAILED — could not resolve dist-tag: ${(e as Error).message}`,
      );
      failed = true;
      continue;
    }
    if (resolved === pinned) {
      console.log(`${harness}: ${pinned} (up to date)`);
    } else {
      console.log(`${harness}: pinned ${pinned}, dist-tag resolves to ${resolved} (drifted)`);
      drifted = true;
    }
  }
  if (failed) return 2;
  return drifted ? 1 : 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
