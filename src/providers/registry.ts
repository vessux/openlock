import { ANTHROPIC } from "./anthropic";
import { OPENROUTER } from "./openrouter";
import type { ProviderId, ProviderPlugin } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderPlugin> = {
  anthropic: ANTHROPIC,
  openrouter: OPENROUTER,
};

export const PROVIDER_IDS: readonly ProviderId[] = Object.keys(PROVIDERS) as ProviderId[];

export function validateProviderId(value: string): ProviderId {
  if (PROVIDER_IDS.includes(value as ProviderId)) return value as ProviderId;
  throw new Error(
    `${JSON.stringify(value)} is not a recognized provider. Allowed: ${PROVIDER_IDS.join(", ")}`,
  );
}
