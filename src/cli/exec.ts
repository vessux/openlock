import { SANDBOX_PREFIX } from "../sandbox/constants";
import { inspectContainerState, execCmd as runExec, startContainer } from "../sandbox/container";
import { resolveSessionName } from "./_resolve";

export async function execCmd(args: string[]): Promise<number> {
  const dashIdx = args.indexOf("--");
  const before = dashIdx === -1 ? args : args.slice(0, dashIdx);
  const after = dashIdx === -1 ? [] : args.slice(dashIdx + 1);
  if (after.length === 0) {
    console.error("usage: openlock exec [name] -- <cmd...>");
    return 1;
  }
  const positional = before.find((a) => !a.startsWith("--"));
  const name = await resolveSessionName(positional, "exec into");
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
  return await runExec(containerName, after);
}
