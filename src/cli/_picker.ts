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
  _action: string,
  io: PickerIO,
): Promise<SessionMeta | null> {
  if (sessions.length === 0) return null;
  if (!io.isTTY) return null;
  return null;
}
