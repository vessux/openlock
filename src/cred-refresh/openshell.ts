import { commandExists } from "../command-exists";

export type OpenshellCmd = { bin: string; prefix: string[] };

export async function resolveOpenshellBin(): Promise<OpenshellCmd> {
  if (process.env.OPENSHELL_BIN) {
    return { bin: process.env.OPENSHELL_BIN, prefix: [] };
  }

  if (commandExists("openshell")) {
    return { bin: "openshell", prefix: [] };
  }

  return { bin: "mise", prefix: ["exec", "--", "openshell"] };
}

export async function runProviderUpdate(
  cmd: OpenshellCmd,
  providerName: string,
  credentials: Record<string, string>,
): Promise<{ ok: boolean; stderr: string }> {
  const args = [...cmd.prefix, "provider", "update", providerName];

  // Pass credential values through the child's env, not argv: the fork resolves
  // a bare `--credential KEY` from its own env, keeping the secret out of the
  // world-readable /proc/<pid>/cmdline.
  const credEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    args.push("--credential", key);
    credEnv[key] = value;
  }

  const proc = Bun.spawn([cmd.bin, ...args], {
    env: { ...process.env, ...credEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  return { ok: exitCode === 0, stderr: stderr.trim() };
}
