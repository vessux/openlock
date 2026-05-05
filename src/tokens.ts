import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export function credentialsPath(): string {
  return join(homedir(), ".config", "openlock", "credentials.json");
}

export function readToken(path?: string): string | null {
  const p = path ?? credentialsPath();
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    return typeof data.token === "string" ? data.token : null;
  } catch {
    return null;
  }
}

export function writeToken(path: string, token: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const data = JSON.stringify({ token, created_at: new Date().toISOString() }, null, 2);
  writeFileSync(path, data, { mode: 0o600 });
}
