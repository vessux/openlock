import type { CredentialBundle } from "../config-core";

/** Resolve a bundle's credential values from a host env map. Every declared
 * `from_env` var MUST be present and non-empty — an unset var is a hard error
 * (explicit, no silent skip). The returned map is credential-env-key → value
 * and is routed to the gateway only, never into the sandbox env. */
export function resolveCredentialValues(
  bundle: CredentialBundle,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [credKey, src] of Object.entries(bundle.values)) {
    const value = env[src.from_env];
    if (value === undefined || value === "") {
      throw new Error(
        `credentials['${bundle.name}']: host env var '${src.from_env}' (for ${credKey}) is not set. ` +
          `Export it before running \`openlock sandbox\`.`,
      );
    }
    out[credKey] = value;
  }
  return out;
}
