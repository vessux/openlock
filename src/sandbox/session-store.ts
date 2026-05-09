import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cap } from "./detect-caps";

export interface SessionMeta {
  id: string;
  name: string;
  repoPath: string;
  caps: Cap[];
  image: string;
  policy: string;
  createdAt: string;
  lastAttachedAt: string | null;
  attachedPid: number | null;
}

interface LegacyMeta extends Omit<SessionMeta, "repoPath"> {
  repoPath?: string;
  path?: string;
}

function migrateMeta(raw: LegacyMeta): SessionMeta {
  if (raw.repoPath === undefined && typeof raw.path === "string") {
    const { path, ...rest } = raw;
    return { ...rest, repoPath: path };
  }
  const { path: _legacy, ...rest } = raw;
  return rest as SessionMeta;
}

export function sessionsDir(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".local", "state", "openlock", "sessions");
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
  const metaPath = join(sessionDirById(baseDir, id), "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return migrateMeta(JSON.parse(readFileSync(metaPath, "utf-8")) as LegacyMeta);
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

export function findSessionsByPath(baseDir: string, repoPath: string): SessionMeta[] {
  return listAllSessions(baseDir).filter((m) => m.repoPath === repoPath);
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
