import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
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
}

export async function login(args: LoginArgs = {}): Promise<void> {
  const io = makeRealIO();
  await _loginForTests({ providerFlag: args.providerFlag, io, pick: defaultPicker });
}

export async function _loginForTests(args: {
  providerFlag?: string;
  io: LoginIO;
  pick: (io: LoginIO) => Promise<ProviderId>;
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
}
