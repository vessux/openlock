type Doc = Record<string, unknown>;

function isPlainObject(v: unknown): v is Doc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Append two list-valued keys. Concatenates only when BOTH are arrays; if
 * exactly one side is present it passes through unchanged; if both are present
 * but a side is not an array, local wins so the downstream schema validator
 * still sees (and rejects) the bad type instead of us silently dropping it. */
function mergeList(base: unknown, local: unknown): unknown {
  if (local === undefined) return base;
  if (base === undefined) return local;
  if (Array.isArray(base) && Array.isArray(local)) return [...base, ...local];
  return local;
}

function mergeEnv(base: unknown, local: unknown): unknown {
  if (local === undefined) return base;
  if (base === undefined) return local;
  if (isPlainObject(base) && isPlainObject(local)) return { ...base, ...local };
  return local;
}

/**
 * Overlay a user-local manifest doc onto the base manifest doc. Both are raw,
 * pre-parse values (as returned by `yaml.load`). Rules: scalars (`harness`) and
 * any unknown keys — local wins; `env` — shallow per-key merge, local wins;
 * `mounts`/`args`/`credentials` — append (base ++ local). An absent/empty local
 * returns the base unchanged. Type validation is left to
 * `parseManifest`/`lintManifest`; this only shapes the merged doc.
 */
export function mergeManifestDocs(base: unknown, local: unknown): unknown {
  if (local === undefined || local === null) return base ?? {};
  const b = isPlainObject(base) ? base : {};
  const l = isPlainObject(local) ? local : {};
  const merged: Doc = { ...b, ...l };
  const env = mergeEnv(b.env, l.env);
  const mounts = mergeList(b.mounts, l.mounts);
  const args = mergeList(b.args, l.args);
  const credentials = mergeList(b.credentials, l.credentials);
  const recomputed: Doc = { env, mounts, args, credentials };
  for (const [k, v] of Object.entries(recomputed)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}
