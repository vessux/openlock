import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import {
  fetchOpenRouterUserModelsFromApi,
  getPermittedModels,
  renderProviderModelsResult,
} from "../providers/openrouter-user-models";
import { PROVIDER_IDS, PROVIDERS, validateProviderId } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { type CredentialHealth, getProviderGatewayHealth } from "../sandbox/ensure-provider";
import { readProvider } from "../tokens";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

// Handles `providers models <id>` once providersCmd has already confirmed
// positionals[0] === "models". Split out of providersCmd to keep that
// function's cognitive complexity down; also gives the fetch-injection
// comment below a home separate from the subcommand-routing logic above it.
async function runProvidersModels(positionals: readonly string[]): Promise<void> {
  const idArg = positionals[1];
  if (idArg === undefined) {
    throw new Error("Usage: openlock providers models <id>");
  }
  // Extra positionals after the id (`providers models openrouter junk`) must
  // error too, not be silently ignored — same "no silent wrong behavior"
  // reasoning as the unknown-subcommand check in providersCmd.
  if (positionals.length > 2) {
    throw new Error(
      "Usage: openlock providers models <id> — unexpected extra argument(s): " +
        positionals.slice(2).join(" "),
    );
  }
  const id = validateProviderId(idArg);
  // fetchOpenRouterUserModelsFromApi is passed explicitly here, never as a
  // default parameter value — this is openlock's first host-side
  // authenticated provider API call (openlock-p60), so the real network
  // implementation is wired in at exactly this one production call site and
  // nowhere else; getPermittedModels itself has no fallback that could
  // silently reach the network from a test that forgot to inject a mock.
  const result = await getPermittedModels(id, fetchOpenRouterUserModelsFromApi);
  for (const line of renderProviderModelsResult(id, result)) console.log(line);
}

export async function providersCmd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("providers", flagSchema, "[models <id>]");
    return;
  }
  // A positional that isn't "models" must error, not silently fall through to
  // the status table below — a typo'd subcommand (`providers modles ...`) or
  // a plausible-guess syntax (`providers openrouter`) would otherwise print a
  // table the user didn't ask for and exit 0, giving no signal the command
  // wasn't understood. This is the same defect family as the v0.11.2 sweep
  // ("openlock did the wrong thing silently while every surface reported
  // success") — openlock-p60 follow-up.
  if (positionals.length > 0 && positionals[0] !== "models") {
    throw new Error(
      `Unknown providers subcommand "${positionals[0]}". Usage: openlock providers models <id>`,
    );
  }
  if (positionals[0] === "models") {
    return runProvidersModels(positionals);
  }

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
