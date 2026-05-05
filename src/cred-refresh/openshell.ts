export type OpenshellCmd = { bin: string; prefix: string[] };

export async function resolveOpenshellBin(): Promise<OpenshellCmd> {
  if (process.env.OPENSHELL_BIN) {
    return { bin: process.env.OPENSHELL_BIN, prefix: [] };
  }

  const which = Bun.spawnSync(["which", "openshell"]);
  if (which.exitCode === 0) {
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

  for (const [key, value] of Object.entries(credentials)) {
    args.push("--credential", `${key}=${value}`);
  }

  const proc = Bun.spawn([cmd.bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  return { ok: exitCode === 0, stderr: stderr.trim() };
}
