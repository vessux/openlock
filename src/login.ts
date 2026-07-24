import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { readGlobalConfig } from "./global-config";
import { persistGlobalDefault } from "./global-config/persist";
import { PROVIDERS, validateProviderId } from "./providers/registry";
import type { LoginIO, ProviderId } from "./providers/types";
import { writeProvider } from "./tokens";

function makeRealIO(): LoginIO {
  return {
    isTTY: Boolean(stdin.isTTY),
    writeStdout: (s) => stdout.write(s),
    writeStderr: (s) => stderr.write(s),
    async readLine(prompt: string): Promise<string> {
      const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
      return new Promise<string>((resolve) => {
        rl.question(prompt, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },
  };
}

async function defaultPicker(io: LoginIO): Promise<ProviderId> {
  const ids = Object.keys(PROVIDERS) as ProviderId[];
  io.writeStdout("Select a provider:\n");
  ids.forEach((id, i) => {
    io.writeStdout(`  ${i + 1}. ${id}  (${PROVIDERS[id].displayName})\n`);
  });
  const answer = (await io.readLine("> ")).trim();
  const asNumber = Number.parseInt(answer, 10);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= ids.length) {
    return ids[asNumber - 1];
  }
  return validateProviderId(answer);
}

export interface LoginArgs {
  providerFlag?: string;
  /**
   * When false, don't offer to set/switch default_provider. `openlock setup`
   * sets this false because it persists default_provider itself, so the
   * interactive login it drives should not also prompt for the default.
   */
  offerDefault?: boolean;
}

export async function login(args: LoginArgs = {}): Promise<void> {
  const io = makeRealIO();
  await _loginForTests({
    providerFlag: args.providerFlag,
    io,
    pick: defaultPicker,
    offerDefault: args.offerDefault,
    readDefaultProvider: () => readGlobalConfig()?.defaultProvider,
    persistDefaultProvider: (id) => persistGlobalDefault("default_provider", id),
  });
}

/**
 * After a successful login, offer to record the just-chosen provider as
 * default_provider so the next `openlock sandbox` resolves without a flag.
 * The choice is explicit (a flag or an interactive pick), so persisting it does
 * not violate the no-implicit-provider rule. Skips silently off a TTY (a
 * non-interactive caller can't answer, so stay strictly explicit) and never
 * clobbers a differing default without asking.
 */
async function maybeOfferDefault(
  args: {
    io: LoginIO;
    offerDefault?: boolean;
    readDefaultProvider?: () => string | undefined;
    persistDefaultProvider?: (id: ProviderId) => void;
  },
  id: ProviderId,
): Promise<void> {
  if (args.offerDefault === false || !args.io.isTTY) return;
  if (!args.readDefaultProvider || !args.persistDefaultProvider) return;
  const current = args.readDefaultProvider();
  if (current === id) return;

  let accept: boolean;
  if (!current) {
    const ans = (await args.io.readLine(`Set '${id}' as your default provider? [Y/n] `))
      .trim()
      .toLowerCase();
    accept = ans === "" || ans === "y" || ans === "yes";
  } else {
    const ans = (
      await args.io.readLine(`Change your default provider from '${current}' to '${id}'? [y/N] `)
    )
      .trim()
      .toLowerCase();
    accept = ans === "y" || ans === "yes";
  }
  if (accept) {
    args.persistDefaultProvider(id);
    args.io.writeStdout(`default_provider: ${id}\n`);
  }
}

export async function _loginForTests(args: {
  providerFlag?: string;
  io: LoginIO;
  pick: (io: LoginIO) => Promise<ProviderId>;
  offerDefault?: boolean;
  readDefaultProvider?: () => string | undefined;
  persistDefaultProvider?: (id: ProviderId) => void;
}): Promise<void> {
  const id = args.providerFlag ? validateProviderId(args.providerFlag) : await args.pick(args.io);
  const plugin = PROVIDERS[id];
  args.io.writeStdout(`\nAuthenticating with ${plugin.displayName}...\n`);
  const result = await plugin.loginInteractive(args.io);
  writeProvider(id, {
    type: plugin.openshellType,
    credentials: result.credentials,
    created_at: new Date().toISOString(),
    refresh: result.refresh,
  });
  args.io.writeStdout(`\nCredentials saved for provider '${id}'.\n`);
  await maybeOfferDefault(args, id);
}
