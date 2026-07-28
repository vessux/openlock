import type { ParseArgsOptionsConfig } from "node:util";
import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { type CredentialHealth, getProviderGatewayHealth } from "../sandbox/ensure-provider";
import { readProvider } from "../tokens";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function providersCmd(_args: string[]): Promise<void> {
  const stored = new Map<ProviderId, boolean>();
  for (const id of PROVIDER_IDS) stored.set(id, readProvider(id) !== null);

  const inGateway = new Set<ProviderId>();
  const credentialHealthById = new Map<ProviderId, CredentialHealth>();
  const refreshHealthById = new Map<ProviderId, "ok" | "error" | null>();

  for (const id of PROVIDER_IDS) {
    try {
      // openlock-7mh: `in_gateway=yes` alone is misleading when the credential
      // behind it is expired — report the SAME expiry signal the gateway's own
      // skip check uses (and, for refresh-capable providers, whether the
      // refresh worker's last attempt errored), not mere presence.
      const health = await getProviderGatewayHealth(id);
      if (health.inGateway) inGateway.add(id);
      credentialHealthById.set(id, health.credential);
      refreshHealthById.set(id, health.refresh);
    } catch {
      // gateway unreachable; leave this provider's gateway state unknown
    }
  }

  const lines = _renderProvidersTable({
    inGateway,
    getStored: (id) => (stored.get(id) ? {} : null),
    getCredentialHealth: (id) => credentialHealthById.get(id) ?? "unknown",
    getRefreshHealth: (id) => refreshHealthById.get(id) ?? null,
  });
  for (const l of lines) console.log(l);
}

export function _renderProvidersTable(opts: {
  inGateway: ReadonlySet<ProviderId>;
  getStored: (id: ProviderId) => unknown | null;
  getCredentialHealth?: (id: ProviderId) => CredentialHealth;
  getRefreshHealth?: (id: ProviderId) => "ok" | "error" | null;
}): string[] {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    const storedFlag = opts.getStored(id) !== null ? "yes" : "no";
    const gwFlag = opts.inGateway.has(id) ? "yes" : "no";
    const credential = opts.getCredentialHealth ? opts.getCredentialHealth(id) : "unknown";
    const refresh = opts.getRefreshHealth ? opts.getRefreshHealth(id) : null;
    const compat = [...p.compatibleHarnesses].join(",");
    return (
      `${id}  stored=${storedFlag}  in_gateway=${gwFlag}  credential=${credential}` +
      `  refresh=${refresh ?? "-"}  harnesses=${compat}`
    );
  });
}
