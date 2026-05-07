import { resolve } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listAllSessions,
  removeSessionDir,
  sessionsDir,
  type SessionMeta,
} from "./session-store";
import {
  inspectContainerState,
  stopContainer,
  removeContainer,
  copyOutOfContainer,
  removeSecretsByPrefix,
  removeVolumesByMatch,
} from "./container";
import { pruneSandboxRefs } from "./git-sync";
import { pidAlive } from "./proc";
import { classifySession, type SessionWithState, type Classification } from "./reap";
import { SANDBOX_PREFIX } from "./session";

export async function loadSessionByName(name: string): Promise<SessionMeta | null> {
  for (const m of listAllSessions(sessionsDir())) {
    if (m.name === name) return m;
  }
  return null;
}

export async function enrichSession(m: SessionMeta): Promise<SessionWithState> {
  const containerState = await inspectContainerState(`${SANDBOX_PREFIX}${m.name}`);
  return {
    ...m,
    containerState,
    pidAlive: pidAlive(m.attachedPid),
  };
}

export interface ClassifiedSession {
  meta: SessionMeta;
  classification: Classification;
  state: SessionWithState;
}

export async function classifyAll(): Promise<ClassifiedSession[]> {
  const out: ClassifiedSession[] = [];
  const now = Date.now();
  for (const m of listAllSessions(sessionsDir())) {
    const state = await enrichSession(m);
    out.push({ meta: m, classification: classifySession(state, now), state });
  }
  return out;
}

export async function stopSession(name: string): Promise<void> {
  const m = await loadSessionByName(name);
  if (!m) throw new Error(`no such session: ${name}`);
  await stopContainer(`${SANDBOX_PREFIX}${m.name}`);
  console.log(`stopped ${name}`);
}

export interface CleanOpts {
  copyDir?: string;
  hostRepoForRefs?: string;
}

export async function cleanSession(name: string, opts: CleanOpts = {}): Promise<void> {
  const m = await loadSessionByName(name);
  if (!m) throw new Error(`no such session: ${name}`);
  const containerName = `${SANDBOX_PREFIX}${m.name}`;

  if (opts.copyDir) {
    const dest = resolve(opts.copyDir);
    rmSync(dest, { recursive: true, force: true });
    const tmp = mkdtempSync(join(tmpdir(), "openlock-copy-"));
    try {
      const regen = Bun.spawn(
        ["podman", "exec", containerName, "bash", "-c",
          "cd /sandbox/repo && git bundle create /sandbox/out.bundle --all"],
        { stdout: "ignore", stderr: "ignore" },
      );
      await regen.exited;
      const ok = await copyOutOfContainer(containerName, "/sandbox/repo", dest);
      if (!ok) {
        console.warn(`failed to copy /sandbox/repo from ${containerName}; continuing teardown`);
      } else {
        console.log(`copied workspace to ${dest}`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  await removeContainer(containerName);
  await removeSecretsByPrefix("openshell-handshake-");
  await removeVolumesByMatch(SANDBOX_PREFIX, "-workspace");
  await pruneSandboxRefs(opts.hostRepoForRefs ?? m.path, m.name);
  removeSessionDir(sessionsDir(), m.id);
  console.log(`cleaned ${name}`);
}

export async function statusSession(name: string): Promise<{
  meta: SessionMeta;
  state: SessionWithState;
  classification: Classification;
}> {
  const m = await loadSessionByName(name);
  if (!m) throw new Error(`no such session: ${name}`);
  const state = await enrichSession(m);
  const classification = classifySession(state, Date.now());
  return { meta: m, state, classification };
}
