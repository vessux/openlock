import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { getSandboxState, harnessEnvFor, execCmd as runExec } from "../sandbox/container";
import { loadSessionByName } from "../sandbox/session-ops";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export async function execCmd(args: string[]): Promise<number> {
  const dashIdx = args.indexOf("--");
  const before = dashIdx === -1 ? args : args.slice(0, dashIdx);
  const after = dashIdx === -1 ? [] : args.slice(dashIdx + 1);
  const { values, positionals } = parseArgs({
    args: before,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("exec", flagSchema, "[name] -- <cmd...>");
    return 0;
  }
  if (after.length === 0) {
    console.error("usage: openlock exec [name] -- <cmd...>");
    return 1;
  }
  const name = await resolveSessionName(positionals[0], "exec into");
  if (!name) return 1;
  const state = await getSandboxState(name);
  if (state === "missing") {
    console.error(`session ${name} has no container`);
    return 1;
  }
  // openlock-04x: without this, `openlock exec <s> -- claude -p ...` ran with
  // NO env injection at all (unlike the attach path, which always goes
  // through buildSandboxEnv/execHarness), so Claude Code couldn't find its
  // staged .credentials.json under /sandbox/.openlock/claude-config and
  // reported "Not logged in · Please run /login" on a fully healthy install.
  // harnessEnvFor is the single function both the attach path (container.ts
  // buildSandboxEnv) and this exec path call, so they can't drift apart
  // again. The session record's `harness` field (not a hardcoded claude_code)
  // is the source of truth here — a session may be opencode, which needs no
  // such var, and injecting it unconditionally would be silently wrong for
  // that harness too. loadSessionByName can return null only on a narrow
  // TOCTOU (session deleted between resolveSessionName and here); fall back
  // to no extra env rather than failing the exec outright — the underlying
  // `openshell sandbox exec` call below will surface the real error anyway.
  const meta = await loadSessionByName(name);
  const harnessEnv = meta ? harnessEnvFor(meta.harness) : {};
  return await runExec(name, after, harnessEnv);
}
