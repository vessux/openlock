import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { PROVIDER_IDS, PROVIDERS } from "../src/providers/registry";
import type { PolicyEndpointSpec } from "../src/providers/types";
import { HARNESSES, type Harness } from "../src/sandbox/harness";

type CapVariant = "default" | "default-js" | "default-py" | "default-js-py";

const CAP_VARIANTS: readonly CapVariant[] = ["default", "default-js", "default-py", "default-js-py"];

const HARNESS_BIN: Record<Harness, string> = {
  claude_code: "/usr/local/bin/claude",
  opencode: "/usr/local/bin/opencode",
};

function harnessBinaries(harness: Harness, variant: CapVariant): Array<{ path: string }> {
  const out: Array<{ path: string }> = [{ path: HARNESS_BIN[harness] }];
  if (variant !== "default-py") out.push({ path: "/usr/bin/node" });
  if (variant === "default-py" || variant === "default-js-py") out.push({ path: "/usr/bin/python3" });
  return out;
}

function harnessBlock(harness: Harness, variant: CapVariant): Record<string, unknown> {
  const endpoints: PolicyEndpointSpec[] = [];
  const allowedSecrets = new Set<string>();
  for (const id of PROVIDER_IDS) {
    const plugin = PROVIDERS[id];
    if (!plugin.compatibleHarnesses.has(harness)) continue;
    for (const ep of plugin.policyEndpoints(harness)) {
      endpoints.push(ep);
      for (const inj of ep.cred_inject.inject) {
        allowedSecrets.add(inj.from_credential);
      }
    }
  }
  return {
    binaries: harnessBinaries(harness, variant),
    endpoints: endpoints.map((ep) => ({
      host: ep.host,
      port: ep.port,
      protocol: ep.protocol,
      enforcement: "enforce",
      rules: ep.rules.map((r) => ({ allow: r.allow })),
      cred_inject: {
        provider: ep.cred_inject.provider,
        strip_headers: [...ep.cred_inject.strip_headers],
        inject: ep.cred_inject.inject.map((i) => ({
          header: i.header,
          from_credential: i.from_credential,
        })),
      },
    })),
    allowed_secrets: [...allowedSecrets],
  };
}

function leadingComment(path: string): string {
  const lines = readFileSync(path, "utf-8").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (l.startsWith("#") || l.trim() === "") out.push(l);
    else break;
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

function policiesPath(variant: CapVariant): string {
  return resolve(__dirname, "..", "policies", `${variant}.yaml`);
}

export function renderDefaultPolicy(variant: string): string {
  if (!CAP_VARIANTS.includes(variant as CapVariant)) {
    throw new Error(`Unknown variant ${variant}`);
  }
  const v = variant as CapVariant;
  const path = policiesPath(v);
  const existing = yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const existingNetwork = (existing.network_policies ?? {}) as Record<string, unknown>;

  const harnessNames: Harness[] = [...HARNESSES];
  const newNetwork: Record<string, unknown> = {};
  for (const h of harnessNames) newNetwork[h] = harnessBlock(h, v);
  for (const [k, val] of Object.entries(existingNetwork)) {
    if (harnessNames.includes(k as Harness)) continue;
    newNetwork[k] = val;
  }

  const out = { ...existing, network_policies: newNetwork };
  const header = leadingComment(path);
  return `${header}${yaml.dump(out, { lineWidth: 200, noRefs: true })}`;
}

if (import.meta.main) {
  for (const v of CAP_VARIANTS) {
    const path = policiesPath(v);
    writeFileSync(path, renderDefaultPolicy(v));
    console.log(`rendered ${path}`);
  }
}
