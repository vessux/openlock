import { credentialsPath, writeToken } from "./tokens";

export async function login(): Promise<void> {
  console.log("Running claude setup-token to generate a long-lived OAuth token...\n");

  const proc = Bun.spawn(["claude", "setup-token"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("\nclaude setup-token failed.");
    process.exit(1);
  }

  console.log("\nPaste the token printed above:");
  process.stdout.write("> ");

  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const token = new TextDecoder().decode(value).trim();

  if (!token) {
    console.error("No token provided. Aborting.");
    process.exit(1);
  }

  const path = credentialsPath();
  writeToken(path, token);
  console.log(`Token saved to ${path}`);
}
