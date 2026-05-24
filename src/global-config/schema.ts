import { PROVIDER_IDS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { HARNESSES, type Harness } from "../sandbox/harness";

export interface GlobalConfig {
  defaultHarness?: Harness;
  defaultProvider?: ProviderId;
}

const ALLOWED_KEYS = new Set(["default_harness", "default_provider"]);

function parseDefaultHarness(v: unknown, source: string): Harness {
  if (typeof v !== "string") {
    throw new Error(`${source}: default_harness must be a string`);
  }
  if (!HARNESSES.has(v as Harness)) {
    throw new Error(
      `${source}: default_harness ${JSON.stringify(v)} is not a recognized harness. ` +
        `Allowed: ${[...HARNESSES].join(", ")}`,
    );
  }
  return v as Harness;
}

function parseDefaultProvider(v: unknown, source: string): ProviderId {
  if (typeof v !== "string") {
    throw new Error(`${source}: default_provider must be a string`);
  }
  if (!PROVIDER_IDS.includes(v as ProviderId)) {
    throw new Error(
      `${source}: default_provider ${JSON.stringify(v)} is not a recognized provider. ` +
        `Allowed: ${PROVIDER_IDS.join(", ")}`,
    );
  }
  return v as ProviderId;
}

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
    out.defaultHarness = parseDefaultHarness(obj.default_harness, source);
  }
  if ("default_provider" in obj) {
    out.defaultProvider = parseDefaultProvider(obj.default_provider, source);
  }
  return out;
}
