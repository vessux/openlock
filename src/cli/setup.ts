import { createInterface } from "node:readline";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { readGlobalConfig } from "../global-config";
import { type GlobalDefaultKey, persistGlobalDefault } from "../global-config/persist";
import type { GlobalConfig } from "../global-config/schema";
import { login } from "../login";
import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { type Runtime, resolveRuntime } from "../runtime";
import { type Harness, harnessChoices, harnessDefaultIndex } from "../sandbox/harness";
import { printCmdHelp } from "./_help";

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
  readGlobal: () => GlobalConfig | null;
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

  const current = deps.readGlobal();

  // 1) runtime
  const runtime = await deps.pickRuntime();
  deps.persist("default_runtime", runtime);
  deps.io.write(`default_runtime: ${runtime}\n`);

  // 2) harness — preselect the current default
  const harness = (await deps.io.select(
    "Agent harness",
    harnessChoices(),
    harnessDefaultIndex(current?.defaultHarness),
  )) as Harness;
  deps.persist("default_harness", harness);
  deps.io.write(`default_harness: ${harness}\n`);

  // 3) provider (filtered to harness-compatible ids — SETUP ONLY)
  const ids = compatibleProviders(harness);
  if (ids.length === 0) {
    deps.io.write(`No provider is compatible with harness '${harness}'.\n`);
    return 1;
  }
  const provIdx = current?.defaultProvider ? Math.max(0, ids.indexOf(current.defaultProvider)) : 0;
  const provider = (await deps.io.select(
    "Provider",
    ids.map((id) => ({ label: `${id} (${PROVIDERS[id].displayName})`, value: id })),
    provIdx,
  )) as ProviderId;
  await deps.loginForProvider(provider);
  deps.persist("default_provider", provider);
  deps.io.write(`default_provider: ${provider}\n`);

  deps.io.write(`\nDone. runtime=${runtime} harness=${harness} provider=${provider}\n`);
  deps.io.write("Next: cd <repo> && openlock init\n");
  return 0;
}

function defaultSetupIO(): SetupIO {
  const ask = async (q: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise<string>((res) =>
      rl.question(q, (a) => {
        rl.close();
        res(a);
      }),
    );
  };
  return {
    isTTY: Boolean(process.stdin.isTTY),
    write: (s) => process.stdout.write(s),
    async select(question, options, defIndex) {
      process.stderr.write(`${question}:\n`);
      for (let i = 0; i < options.length; i++) {
        process.stderr.write(`  ${i + 1}) ${options[i].label}\n`);
      }
      const a = (await ask(`> [${defIndex + 1}] `)).trim();
      const n = a === "" ? defIndex + 1 : Number.parseInt(a, 10);
      const idx = Number.isFinite(n) && n >= 1 && n <= options.length ? n - 1 : defIndex;
      return options[idx].value;
    },
  };
}

export async function setupCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: flagSchema, allowPositionals: false });
  if (values.help === true) {
    printCmdHelp("setup", flagSchema, "");
    return 0;
  }
  return runSetup({
    io: defaultSetupIO(),
    readGlobal: readGlobalConfig,
    persist: persistGlobalDefault,
    // resolveRuntime runs the runtime-wizard when ambiguous and persists itself;
    // runSetup also persists default_runtime for determinism.
    pickRuntime: () => resolveRuntime(),
    loginForProvider: (id) => login({ providerFlag: id }),
  });
}
