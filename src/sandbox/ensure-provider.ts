import { readToken } from "../tokens";
import { getCliInvocation } from "./fork-binaries";

async function openshell(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

export async function ensureProvider(): Promise<void> {
  const token = readToken();
  if (!token) {
    console.error("No credentials found. Run `openlock login` first.");
    process.exit(1);
  }

  const { stdout } = await openshell(["provider", "list"]);
  if (stdout.includes("anthropic")) {
    return;
  }

  console.log("Creating anthropic provider...");
  const { exitCode, stderr } = await openshell([
    "provider",
    "create",
    "--name",
    "anthropic",
    "--type",
    "claude",
    "--credential",
    `ANTHROPIC_BEARER_TOKEN=Bearer ${token}`,
    "--credential",
    `ANTHROPIC_AUTH_TOKEN=${token}`,
  ]);
  if (exitCode !== 0) {
    console.error(`Failed to create provider: ${stderr}`);
    process.exit(1);
  }
  console.log("Provider created.");
}
