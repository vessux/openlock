import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cap } from "./detect-caps";

export interface SessionMeta {
  id: string;
  name: string;
  path: string;
  caps: Cap[];
  image: string;
  policy: string;
  createdAt: string;
  lastAttachedAt: string | null;
  attachedPid: number | null;
}

export function sessionsDir(): string {
  return join(homedir(), ".local", "state", "openlock", "sessions");
}

export function sessionDirById(baseDir: string, id: string): string {
  return join(baseDir, id);
}

export function saveSession(baseDir: string, meta: SessionMeta): void {
  const dir = sessionDirById(baseDir, meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function loadSession(baseDir: string, id: string): SessionMeta | null {
  const path = join(sessionDirById(baseDir, id), "meta.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function listAllSessions(baseDir: string): SessionMeta[] {
  if (!existsSync(baseDir)) return [];
  const out: SessionMeta[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = loadSession(baseDir, entry.name);
    if (meta !== null) out.push(meta);
  }
  return out;
}

export function findSessionsByPath(baseDir: string, path: string): SessionMeta[] {
  return listAllSessions(baseDir).filter((m) => m.path === path);
}

export function removeSessionDir(baseDir: string, id: string): void {
  rmSync(sessionDirById(baseDir, id), { recursive: true, force: true });
}

export function updateSessionMeta(
  baseDir: string,
  id: string,
  patch: Partial<Omit<SessionMeta, "id">>,
): void {
  const cur = loadSession(baseDir, id);
  if (cur === null) throw new Error(`session not found: ${id}`);
  const next = { ...cur, ...patch };
  saveSession(baseDir, next);
}
