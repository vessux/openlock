import type { Harness } from "../sandbox/harness";
import { readProvider } from "../tokens";
import { PROVIDERS, validateProviderId } from "./registry";
import type { ProviderId } from "./types";

export interface ResolveProviderArgs {
  harness: Harness;
  cliFlag?: string;
  env: Readonly<Record<string, string | undefined>>;
  readGlobalConfig: () => { defaultProvider?: string } | null;
}

let deprecationHintEmitted = false;

function emitBackwardCompatHint(): void {
  if (deprecationHintEmitted) return;
  deprecationHintEmitted = true;
  console.error(
    "openlock: no --provider given, defaulting to 'anthropic' for harness 'claude_code'.\n" +
      "          This auto-default will be removed in v0.8.0. Set --provider, OPENLOCK_PROVIDER,\n" +
      "          or `default_provider: anthropic` in ~/.config/openlock/config.yaml to silence.",
  );
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

  // Backward-compat: claude_code + stored anthropic creds -> anthropic + one-shot hint.
  if (args.harness === "claude_code" && readProvider("anthropic") !== null) {
    emitBackwardCompatHint();
    return "anthropic";
  }

  throw new Error(
    `No provider selected for harness '${args.harness}'. Pass --provider, set OPENLOCK_PROVIDER, ` +
      `or set default_provider: in ~/.config/openlock/config.yaml.`,
  );
}

// Test helper to reset the once-per-process hint emission. Not exported from src/providers/index.
export function _resetDeprecationHintForTests(): void {
  deprecationHintEmitted = false;
}
