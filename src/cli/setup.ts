import type { ParseArgsOptionsConfig } from "node:util";
import type { GlobalDefaultKey } from "../global-config/persist";
import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import type { Runtime } from "../runtime";
import { HARNESSES, type Harness } from "../sandbox/harness";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export function compatibleProviders(harness: Harness): ProviderId[] {
  return PROVIDER_IDS.filter((id) => PROVIDERS[id].compatibleHarnesses.has(harness));
}

interface SetupIO {
  isTTY: boolean;
  write(s: string): void;
  select(
    question: string,
    options: { label: string; value: string }[],
    defIndex: number,
  ): Promise<string>;
}

export interface SetupDeps {
  io: SetupIO;
  persist: (key: GlobalDefaultKey, value: string) => void;
  pickRuntime: () => Promise<Runtime>;
  loginForProvider: (id: ProviderId) => Promise<void>;
}

export async function runSetup(deps: SetupDeps): Promise<number> {
  if (!deps.io.isTTY) {
    deps.io.write(
      "openlock setup is interactive. Set defaults manually in ~/.config/openlock/config.yaml " +
        "(default_runtime, default_harness, default_provider) or via OPENLOCK_RUNTIME / " +
        "OPENLOCK_HARNESS / OPENLOCK_PROVIDER.\n",
    );
    return 1;
  }

  // 1) runtime
  const runtime = await deps.pickRuntime();
  deps.persist("default_runtime", runtime);
  deps.io.write(`default_runtime: ${runtime}\n`);

  // 2) harness
  const harnessOptions = [...HARNESSES].map((h) => ({ label: h, value: h }));
  const harness = (await deps.io.select("Agent harness", harnessOptions, 0)) as Harness;
  deps.persist("default_harness", harness);
  deps.io.write(`default_harness: ${harness}\n`);

  // 3) provider (filtered to harness-compatible ids — SETUP ONLY)
  const ids = compatibleProviders(harness);
  if (ids.length === 0) {
    deps.io.write(`No provider is compatible with harness '${harness}'.\n`);
    return 1;
  }
  const provider = (await deps.io.select(
    "Provider",
    ids.map((id) => ({ label: `${id} (${PROVIDERS[id].displayName})`, value: id })),
    0,
  )) as ProviderId;
  await deps.loginForProvider(provider);
  deps.persist("default_provider", provider);
  deps.io.write(`default_provider: ${provider}\n`);

  deps.io.write(`\nDone. runtime=${runtime} harness=${harness} provider=${provider}\n`);
  deps.io.write("Next: cd <repo> && openlock init\n");
  return 0;
}
