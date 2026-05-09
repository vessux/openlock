import { resolve } from "node:path";
import { loadSessionByName } from "../sandbox/session-ops";
import {
  findSessionsByPath,
  listAllSessions,
  type SessionMeta,
  sessionsDir,
} from "../sandbox/session-store";
import { defaultPickerIO, pickSession } from "./_picker";

export type PickFn = (sessions: SessionMeta[], action: string) => Promise<SessionMeta | null>;

const defaultPick: PickFn = (sessions, action) => pickSession(sessions, action, defaultPickerIO());

export async function resolveSessionName(
  positional: string | undefined,
  action: string,
  pick: PickFn = defaultPick,
): Promise<string | null> {
  if (positional) {
    const m = await loadSessionByName(positional);
    if (!m) {
      console.error(`no such session: ${positional}`);
      return null;
    }
    return m.name;
  }
  const baseDir = sessionsDir();
  const cwd = resolve(process.cwd());
  const matches = findSessionsByPath(baseDir, cwd);

  if (matches.length === 1) return matches[0]!.name;

  if (matches.length > 1) {
    const picked = await pick(matches, action);
    if (picked) return picked.name;
    console.error(`multiple sessions for ${cwd}; pass a session name to ${action}:`);
    for (const m of matches) console.error(`  ${m.name}`);
    return null;
  }

  const all = listAllSessions(baseDir);
  if (all.length > 0) {
    const picked = await pick(all, action);
    if (picked) return picked.name;
  }
  console.error(`no session for ${cwd}; pass a session name to ${action}`);
  return null;
}
