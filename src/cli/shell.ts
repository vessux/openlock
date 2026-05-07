import { execBash, inspectContainerState, startContainer } from "../sandbox/container";
import { SANDBOX_PREFIX } from "../sandbox/session";
import { resolveSessionName } from "./_resolve";

export async function shellCmd(args: string[]): Promise<number> {
  const positional = args.find((a) => !a.startsWith("--"));
  const name = await resolveSessionName(positional, "shell into");
  if (!name) return 1;
  const containerName = `${SANDBOX_PREFIX}${name}`;
  const state = await inspectContainerState(containerName);
  if (state === "missing") {
    console.error(`session ${name} has no container`);
    return 1;
  }
  if (state === "exited") {
    await startContainer(containerName);
  }
  return await execBash(containerName);
}
