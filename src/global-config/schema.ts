import { HARNESSES, type Harness } from "../sandbox/harness";

export interface GlobalConfig {
  defaultHarness?: Harness;
}

const ALLOWED_KEYS = new Set(["default_harness"]);

export function validateAndShape(raw: unknown, source: string): GlobalConfig {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: root must be a YAML object (mapping)`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `${source}: unknown top-level key "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}`,
      );
    }
  }
  const out: GlobalConfig = {};
  if ("default_harness" in obj) {
    const v = obj.default_harness;
    if (typeof v !== "string") {
      throw new Error(`${source}: default_harness must be a string`);
    }
    if (!HARNESSES.has(v as Harness)) {
      throw new Error(
        `${source}: default_harness ${JSON.stringify(v)} is not a recognized harness. ` +
          `Allowed: ${[...HARNESSES].join(", ")}`,
      );
    }
    out.defaultHarness = v as Harness;
  }
  return out;
}
