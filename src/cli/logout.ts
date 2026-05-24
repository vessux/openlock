import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { PROVIDER_IDS, validateProviderId } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { deleteProvider, readProvider } from "../tokens";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  provider: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function logoutCmd(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: flagSchema, allowPositionals: false });
  if (values.help === true) {
    printCmdHelp("logout", flagSchema, "[--provider <id>]");
    return;
  }
  await _logoutForTests({ providerFlag: values.provider, pick: defaultPick });
}

async function defaultPick(): Promise<ProviderId> {
  const stored = PROVIDER_IDS.filter((id) => readProvider(id) !== null);
  if (stored.length === 0) throw new Error("No providers are stored. Nothing to log out from.");
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<ProviderId>((resolve, reject) => {
    console.log("Logout from which provider?");
    for (let i = 0; i < stored.length; i++) console.log(`  ${i + 1}. ${stored[i]}`);
    rl.question("> ", (ans) => {
      rl.close();
      const trimmed = ans.trim();
      const n = Number.parseInt(trimmed, 10);
      if (Number.isInteger(n) && n >= 1 && n <= stored.length) return resolve(stored[n - 1]);
      try {
        const id = validateProviderId(trimmed);
        if (!stored.includes(id)) return reject(new Error(`No credentials stored for '${id}'.`));
        resolve(id);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function _logoutForTests(args: {
  providerFlag?: string;
  pick: () => Promise<ProviderId>;
}): Promise<void> {
  const stored = PROVIDER_IDS.filter((id) => readProvider(id) !== null);
  if (stored.length === 0 && !args.providerFlag) {
    throw new Error("No providers are stored. Nothing to log out from.");
  }
  const id = args.providerFlag ? validateProviderId(args.providerFlag) : await args.pick();
  if (readProvider(id) === null) {
    throw new Error(`No credentials stored for '${id}'.`);
  }
  deleteProvider(id);
  console.log(`Credentials for provider '${id}' removed.`);
}
