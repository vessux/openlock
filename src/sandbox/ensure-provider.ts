import { PROVIDERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { readProvider } from "../tokens";
import { getCliInvocation } from "./fork-binaries";

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function realOpenshell(args: string[]): Promise<ShellResult> {
  const cli = await getCliInvocation();
  const proc = Bun.spawn([...cli.argv, ...args], {
    cwd: cli.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// `openshell provider list` prints a space-aligned table:
//   NAME      TYPE     CREDENTIAL_KEYS  CONFIG_KEYS
//   anthropic claude   2                0
//   ...
// (with ANSI bold on the header). Match a line whose first whitespace-
// separated token equals the provider id, after stripping ANSI escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI ESC requires the 0x1b control byte.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function providerExistsInGateway(listStdout: string, providerId: ProviderId): boolean {
  return listStdout
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === providerId);
}

export async function ensureProvider(providerId: ProviderId): Promise<void> {
  await _ensureProviderForTests(providerId, realOpenshell);
}

export async function _ensureProviderForTests(
  providerId: ProviderId,
  shell: (args: string[]) => Promise<ShellResult>,
): Promise<void> {
  const record = readProvider(providerId);
  if (!record) {
    throw new Error(
      `No credentials for provider '${providerId}'. Run \`openlock login --provider ${providerId}\` first.`,
    );
  }

  const list = await shell(["provider", "list"]);
  if (list.exitCode !== 0) {
    throw new Error(`Failed to query gateway providers: ${list.stderr || list.stdout}`);
  }
  const exists = providerExistsInGateway(list.stdout, providerId);

  const credArgs = Object.entries(record.credentials).flatMap(([k, v]) => [
    "--credential",
    `${k}=${v}`,
  ]);
  const args = exists
    ? ["provider", "update", providerId, ...credArgs]
    : ["provider", "create", "--name", providerId, "--type", record.type, ...credArgs];

  const result = await shell(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to ${exists ? "update" : "create"} provider '${providerId}' in gateway: ${result.stderr}`,
    );
  }

  // Defensive: warn if the plugin's declared openshellType drifts from the stored record.
  if (PROVIDERS[providerId].openshellType !== record.type) {
    console.warn(
      `openlock: provider '${providerId}' stored type='${record.type}' differs from plugin openshellType='${PROVIDERS[providerId].openshellType}'.`,
    );
  }
}
