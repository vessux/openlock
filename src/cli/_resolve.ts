import { resolve } from "node:path";
import { loadSessionByName } from "../sandbox/session-ops";
import { findSessionsByPath, sessionsDir } from "../sandbox/session-store";

export async function resolveSessionName(
  positional: string | undefined,
  action: string,
): Promise<string | null> {
  if (positional) {
    const m = await loadSessionByName(positional);
    if (!m) {
      console.error(`no such session: ${positional}`);
      return null;
    }
    return m.name;
  }
  const matches = findSessionsByPath(sessionsDir(), resolve(process.cwd()));
  if (matches.length === 0) {
    console.error(`no session for ${process.cwd()}; pass a session name to ${action}`);
    return null;
  }
  if (matches.length > 1) {
    console.error(`multiple sessions for ${process.cwd()}; pass a session name to ${action}:`);
    for (const m of matches) console.error(`  ${m.name}`);
    return null;
  }
  return matches[0]!.name;
}
