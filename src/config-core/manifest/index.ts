import yaml from "js-yaml";
import type {
  ConfigFile,
  CredentialBundle,
  Issue,
  ManifestConfig,
  Mount,
  MountType,
} from "../types";
import { resolveSource, validateManifestFilesystem } from "./filesystem";
import { validateManifestSchema } from "./schema";
import { validateManifestSemantics } from "./semantic";

export {
  CREDENTIAL_ENTRY_KEYS,
  CREDENTIAL_SOURCE_KEYS,
  MANIFEST_KEYS,
  MOUNT_ENTRY_KEYS,
  MOUNT_TYPES,
} from "./schema";

interface ParsedDoc {
  doc: unknown;
  parseError?: Issue;
}

/** Normalize raw input (a YAML string or an already-parsed value) to a doc.
 * A YAML syntax error is returned as a collectible Issue, not thrown. */
function parseDoc(raw: unknown): ParsedDoc {
  if (typeof raw !== "string") return { doc: raw ?? {} };
  try {
    return { doc: yaml.load(raw) ?? {} };
  } catch (e) {
    return {
      doc: {},
      parseError: {
        file: "config.yaml",
        severity: "error",
        path: "",
        message: `YAML parse error: ${(e as Error).message}`,
      },
    };
  }
}

/** Collect-all validation. Accepts either a YAML string or an already-parsed
 * object. Schema errors short-circuit semantic/filesystem (a structurally
 * broken doc can't be meaningfully cross-checked). */
export function lintManifest(
  raw: unknown,
  projectRoot: string,
  opts: { offline: boolean; file?: ConfigFile },
): Issue[] {
  const file: ConfigFile = opts.file ?? "config.yaml";
  const { doc, parseError } = parseDoc(raw);
  if (parseError) return [{ ...parseError, file }];
  const schema = validateManifestSchema(doc);
  if (schema.length > 0) return schema.map((i) => ({ ...i, file }));
  const obj = doc as Record<string, unknown>;
  const semantic = validateManifestSemantics(obj);
  const filesystem = opts.offline ? [] : validateManifestFilesystem(obj, projectRoot);
  return [...semantic, ...filesystem].map((i) => ({ ...i, file }));
}

/** Strict parse for the runtime launch path. Throws the first blocking issue
 * (error or filesystem). The message body matches the validator's message; the
 * `mounts[i]` location the old runtime prefixed now lives in the issue's path. */
export function parseManifest(raw: unknown, projectRoot: string): ManifestConfig {
  const issues = lintManifest(raw, projectRoot, { offline: false });
  const blocking = issues[0];
  if (blocking) throw new Error(blocking.message);
  const obj = parseDoc(raw).doc as Record<string, unknown>;
  const rawMounts = Array.isArray(obj.mounts) ? obj.mounts : [];
  const mounts: Mount[] = rawMounts.map((m) => {
    const rm = m as { source: string; target: string; type: MountType; readOnly?: boolean };
    const mount: Mount = {
      source: resolveSource(projectRoot, rm.source),
      target: rm.target,
      type: rm.type,
    };
    if (rm.readOnly !== undefined) mount.readOnly = rm.readOnly;
    return mount;
  });
  const args = Array.isArray(obj.args) ? (obj.args as string[]) : [];
  const env = (obj.env ?? {}) as Record<string, string>;
  const credentials = Array.isArray(obj.credentials) ? (obj.credentials as CredentialBundle[]) : [];
  const config: ManifestConfig = { mounts, args, env, credentials };
  // Validated by lintManifest above, so this is a known harness or absent.
  if (typeof obj.harness === "string") config.harness = obj.harness as ManifestConfig["harness"];
  // Validated by lintManifest above (validateResourceLimit), so these are
  // non-empty strings or absent — the actual quantity grammar is openshell's
  // own to validate at create time (openlock-251).
  if (typeof obj.cpu === "string") config.cpu = obj.cpu;
  if (typeof obj.memory === "string") config.memory = obj.memory;
  return config;
}
