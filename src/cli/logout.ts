import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { PROVIDER_IDS, validateProviderId } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { deleteGatewayProvider } from "../sandbox/ensure-provider";
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
  await _logoutForTests({
    providerFlag: values.provider,
    pick: defaultPick,
    clearGateway: deleteGatewayProvider,
  });
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
  /**
   * REQUIRED, deliberately un-defaulted. An optional dep that falls back to
   * the real gateway RPC is a live-state footgun: a test that simply forgets
   * to pass it silently deletes the developer's own gateway providers. That
   * is not hypothetical — it happened while writing these very tests. Making
   * it required moves the mistake from runtime to compile time.
   */
  clearGateway: (name: string) => Promise<boolean>;
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

  // Clear the gateway row too (openlock-9ej). The gateway's copy — not
  // credentials.json — is what gets injected into a sandbox, so a local-only
  // logout left a revoked token in service and gave the user no way to
  // dislodge it. Best-effort: a stopped gateway must not turn a successful
  // local logout into a failure, so report the outcome instead of throwing.
  if (await args.clearGateway(id)) {
    console.log(`Gateway credential for '${id}' removed.`);
  } else {
    console.log(
      `No gateway credential removed for '${id}' (already absent, or the gateway is not running). ` +
        `If a sandbox still fails to authenticate, start the gateway and re-run this command.`,
    );
  }
}
