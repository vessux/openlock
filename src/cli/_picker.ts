import type { SessionMeta } from "../sandbox/session-store";

export interface PickerIO {
  isTTY: boolean;
  readLine(): Promise<string | null>;
  writeStderr(s: string): void;
  detectFzf(): boolean;
  runFzf(input: string, prompt: string): Promise<string | null>;
}

export async function pickSession(
  sessions: SessionMeta[],
  action: string,
  io: PickerIO,
): Promise<SessionMeta | null> {
  if (sessions.length === 0) return null;
  if (!io.isTTY) return null;

  if (io.detectFzf()) {
    const input = sessions.map((s) => `${s.name}\t${s.repoPath}`).join("\n");
    const selected = await io.runFzf(input, action);
    if (selected === null) return null;
    const name = selected.split("\t")[0];
    return sessions.find((s) => s.name === name) ?? null;
  }

  return null;
}
