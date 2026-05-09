import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function credentialsPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".config", "openlock", "credentials.json");
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
