import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { PROVIDER_IDS, PROVIDERS } from "../src/providers/registry";
import type { PolicyEndpointSpec } from "../src/providers/types";
import { HARNESSES, type Harness } from "../src/sandbox/harness";

const HARNESS_BIN: Record<Harness, string> = {
  claude_code: "/usr/local/bin/claude",
  opencode: "/usr/local/bin/opencode",
};

function harnessBinaries(harness: Harness): Array<{ path: string }> {
  // Base image always ships node (under /usr/local/bin) + python3 (under
  // /usr/bin via apt). Single policy covers both; cap detection is gone.
  return [{ path: HARNESS_BIN[harness] }, { path: "/usr/local/bin/node" }];
}

function harnessBlock(harness: Harness): Record<string, unknown> {
  const endpoints: PolicyEndpointSpec[] = [];
  const allowedSecrets = new Set<string>();
  for (const id of PROVIDER_IDS) {
    const plugin = PROVIDERS[id];
    if (!plugin.compatibleHarnesses.has(harness)) continue;
    for (const ep of plugin.policyEndpoints(harness)) {
      endpoints.push(ep);
      // Endpoints with no cred_inject (public read-only metadata, e.g.
      // models.dev) carry no credential, so contribute nothing to allowed_secrets.
      if (ep.cred_inject) {
        for (const inj of ep.cred_inject.inject) {
          allowedSecrets.add(inj.from_credential);
        }
      }
    }
  }
  return {
    binaries: harnessBinaries(harness),
    endpoints: endpoints.map((ep) => ({
      host: ep.host,
      port: ep.port,
      protocol: ep.protocol,
      enforcement: "enforce",
      rules: ep.rules.map((r) => ({ allow: r.allow })),
      // Only emit cred_inject for endpoints that carry a credential; a
      // cred-less endpoint renders as a pure allow-egress rule.
      ...(ep.cred_inject
        ? {
            cred_inject: {
              provider: ep.cred_inject.provider,
              strip_headers: [...ep.cred_inject.strip_headers],
              inject: ep.cred_inject.inject.map((i) => ({
                header: i.header,
                from_credential: i.from_credential,
                // Preserve the literal prefix (e.g. "Bearer ") when present; a
                // cred whose stored value carries no prefix omits the key.
                ...(i.value_prefix ? { value_prefix: i.value_prefix } : {}),
              })),
            },
          }
        : {}),
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

function policiesPath(): string {
  return resolve(__dirname, "..", "policies", "default.yaml");
}

export function renderDefaultPolicy(): string {
  const path = policiesPath();
  const existing = yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const existingNetwork = (existing.network_policies ?? {}) as Record<string, unknown>;

  const harnessNames: Harness[] = [...HARNESSES];
  const newNetwork: Record<string, unknown> = {};
  for (const h of harnessNames) newNetwork[h] = harnessBlock(h);
  for (const [k, val] of Object.entries(existingNetwork)) {
    if (harnessNames.includes(k as Harness)) continue;
    newNetwork[k] = val;
  }

  const out = { ...existing, network_policies: newNetwork };
  const header = leadingComment(path);
  return `${header}${yaml.dump(out, { lineWidth: 200, noRefs: true })}`;
}

if (import.meta.main) {
  const path = policiesPath();
  writeFileSync(path, renderDefaultPolicy());
  console.log(`rendered ${path}`);
}
