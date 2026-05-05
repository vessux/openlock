import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Cap } from "./detect-caps";

export interface SessionMeta {
  name: string;
  path: string;
  caps: Cap[];
  image: string;
  policy: string;
  createdAt: string;
}

export function sessionsDir(): string {
  return join(homedir(), ".local", "state", "openlock", "sessions");
}

export function saveSession(baseDir: string, meta: SessionMeta): void {
  const dir = join(baseDir, meta.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function loadSession(baseDir: string, name: string): SessionMeta | null {
  const path = join(baseDir, name, "meta.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
