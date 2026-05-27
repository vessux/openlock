import type { Harness } from "../sandbox/harness";
import { PROVIDERS, validateProviderId } from "./registry";
import type { ProviderId } from "./types";

export interface ResolveProviderArgs {
  harness: Harness;
  cliFlag?: string;
  env: Readonly<Record<string, string | undefined>>;
  readGlobalConfig: () => { defaultProvider?: string } | null;
}

function ensureCompatible(id: ProviderId, harness: Harness): void {
  const plugin = PROVIDERS[id];
  if (!plugin.compatibleHarnesses.has(harness)) {
    const compatible = [...plugin.compatibleHarnesses].join(", ");
    throw new Error(
      `Provider '${id}' is not compatible with harness '${harness}'. Compatible harnesses: ${compatible}.`,
    );
  }
}

export function resolveProvider(args: ResolveProviderArgs): ProviderId {
  const explicit =
    args.cliFlag ?? args.env.OPENLOCK_PROVIDER ?? args.readGlobalConfig()?.defaultProvider;
  if (explicit) {
    const id = validateProviderId(explicit);
    ensureCompatible(id, args.harness);
    return id;
  }

  // Explicit-only: never infer a provider. No --provider / OPENLOCK_PROVIDER /
  // default_provider means we error rather than guess.
  throw new Error(
    `No provider selected for harness '${args.harness}'. Pass --provider, set OPENLOCK_PROVIDER, ` +
      `or set default_provider: in ~/.config/openlock/config.yaml.`,
  );
}
