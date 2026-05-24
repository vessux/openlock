import type { ParseArgsOptionsConfig } from "node:util";
import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { providerExistsInGateway } from "../sandbox/ensure-provider";
import { getCliInvocation } from "../sandbox/fork-binaries";
import { readProvider } from "../tokens";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function providersCmd(_args: string[]): Promise<void> {
  const stored = new Map<ProviderId, boolean>();
  for (const id of PROVIDER_IDS) stored.set(id, readProvider(id) !== null);

  let inGateway = new Set<ProviderId>();
  try {
    const cli = await getCliInvocation();
    const proc = Bun.spawn([...cli.argv, "provider", "list"], {
      cwd: cli.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    for (const id of PROVIDER_IDS) {
      if (providerExistsInGateway(stdout, id)) inGateway.add(id);
    }
  } catch {
    // gateway unreachable; leave inGateway empty
    inGateway = new Set();
  }

  const lines = _renderProvidersTable({
    inGateway,
    getStored: (id) => (stored.get(id) ? {} : null),
  });
  for (const l of lines) console.log(l);
}

export function _renderProvidersTable(opts: {
  inGateway: ReadonlySet<ProviderId>;
  getStored: (id: ProviderId) => unknown | null;
}): string[] {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    const storedFlag = opts.getStored(id) !== null ? "yes" : "no";
    const gwFlag = opts.inGateway.has(id) ? "yes" : "no";
    const compat = [...p.compatibleHarnesses].join(",");
    return `${id}  stored=${storedFlag}  in_gateway=${gwFlag}  harnesses=${compat}`;
  });
}
