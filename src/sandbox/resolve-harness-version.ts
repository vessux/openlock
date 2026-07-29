import type { Harness } from "./harness";
import { HARNESS_VERSIONS } from "./harness-versions";

export type DistTags = Record<string, string>;

/** Fetches a package's npm dist-tags. Injectable so callers (CLI, scripts,
 * tests) never have to hit the real registry. */
export type FetchDistTags = (packageName: string) => Promise<DistTags>;

/**
 * Registry endpoint for a package's dist-tags. Scoped package names contain a
 * "/" that must be percent-encoded or the path segment splits in two.
 * Verified 2026-07-29 via curl: both a literal `@` and `encodeURIComponent`'s
 * `%40` are accepted by the registry for the scope prefix, so the standard
 * encoder is safe to use here — e.g.
 * https://registry.npmjs.org/-/package/%40anthropic-ai%2Fclaude-code/dist-tags
 * returned `{"stable":"2.1.212","latest":"2.1.220","next":"2.1.220"}`.
 */
function distTagsUrl(packageName: string): string {
  return `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`;
}

const fetchDistTagsFromRegistry: FetchDistTags = async (packageName) => {
  const res = await fetch(distTagsUrl(packageName));
  if (!res.ok) {
    throw new Error(
      `update-harness: npm registry request failed for ${packageName}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as DistTags;
};

/**
 * Resolves the version a harness's configured dist-tag currently points to.
 * Hard-errors (never falls back to another tag) if the configured tag is
 * absent from the registry response — per the project's no-implicit-fallback
 * rule, silently substituting e.g. `latest` for a missing `stable` would push
 * an uncurated version into every sandbox.
 */
export async function resolveHarnessVersion(
  harness: Harness,
  fetchDistTags: FetchDistTags = fetchDistTagsFromRegistry,
): Promise<string> {
  const { package: pkg, distTag } = HARNESS_VERSIONS[harness];
  const tags = await fetchDistTags(pkg);
  const version = tags[distTag];
  if (version === undefined) {
    const available = Object.keys(tags).join(", ") || "(none)";
    throw new Error(
      `update-harness: dist-tag "${distTag}" not found for ${harness} (${pkg}). ` +
        `Available tags: ${available}`,
    );
  }
  return version;
}
