import { PROVIDER_IDS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { RUNTIMES, type Runtime } from "../runtime";
import { HARNESSES, type Harness } from "../sandbox/harness";

export interface GlobalConfig {
  defaultHarness?: Harness;
  defaultProvider?: ProviderId;
  defaultRuntime?: Runtime;
}

const ALLOWED_KEYS = new Set(["default_harness", "default_provider", "default_runtime"]);

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

function parseDefaultRuntime(v: unknown, source: string): Runtime {
  if (typeof v !== "string") {
    throw new Error(`${source}: default_runtime must be a string`);
  }
  if (!(RUNTIMES as readonly string[]).includes(v)) {
    throw new Error(
      `${source}: default_runtime ${JSON.stringify(v)} is not a recognized runtime. ` +
        `Allowed: ${RUNTIMES.join(", ")}`,
    );
  }
  return v as Runtime;
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
  if ("default_runtime" in obj) {
    out.defaultRuntime = parseDefaultRuntime(obj.default_runtime, source);
  }
  return out;
}
