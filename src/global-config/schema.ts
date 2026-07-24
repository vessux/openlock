import { PROVIDER_IDS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { RUNTIMES, type Runtime } from "../runtime";
import { HARNESSES, type Harness } from "../sandbox/harness";

export interface GlobalConfig {
  defaultHarness?: Harness;
  defaultProvider?: ProviderId;
  defaultRuntime?: Runtime;
  reapIdle?: number | "off";
  networkAutoReload?: boolean;
}

const ALLOWED_KEYS = new Set([
  "default_harness",
  "default_provider",
  "default_runtime",
  "reap_idle",
  "network_auto_reload",
]);

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

const REAP_DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const REAP_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function parseReapIdle(v: unknown, source: string): number | "off" {
  // js-yaml (YAML 1.2) parses `off` as the string "off"; accept boolean
  // false too so a YAML 1.1 schema (or a quoted false) still means "off".
  if (v === false) return "off";
  if (typeof v !== "string") {
    throw new Error(
      `${source}: reap_idle must be "off" or a duration like "30m", "2h", "1d" ` +
        `(got ${JSON.stringify(v)})`,
    );
  }
  const t = v.trim().toLowerCase();
  if (t === "off") return "off";
  const m = REAP_DURATION_RE.exec(t);
  if (!m) {
    throw new Error(
      `${source}: reap_idle ${JSON.stringify(v)} is not "off" or a duration ` +
        `like "30m", "2h", "1d"`,
    );
  }
  return parseInt(m[1]!, 10) * REAP_UNIT_MS[m[2]!]!;
}

// Opt-in (default off): when true, `openlock doctor` auto-runs `podman
// network reload --all` on detected sandbox->gateway unreachability (GH #75)
// instead of only suggesting it. Podman/netavark-specific; harmless-but-unused
// on the docker runtime.
function parseNetworkAutoReload(v: unknown, source: string): boolean {
  if (typeof v !== "boolean") {
    throw new Error(`${source}: network_auto_reload must be a boolean (true or false)`);
  }
  return v;
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
  if ("reap_idle" in obj) {
    out.reapIdle = parseReapIdle(obj.reap_idle, source);
  }
  if ("network_auto_reload" in obj) {
    out.networkAutoReload = parseNetworkAutoReload(obj.network_auto_reload, source);
  }
  return out;
}
