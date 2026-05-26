import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { SANDBOX_PREFIX } from "./constants";
import {
  buildOpenshellExecArgv,
  deleteSandbox,
  downloadFromSandbox,
  getSandboxState,
  stopSandbox,
} from "./container";
import { getCliInvocation } from "./fork-binaries";
import { pruneSandboxRefs } from "./git-sync";
import { pidAlive } from "./proc";
import { type Classification, classifySession, type SessionWithState } from "./reap";
import { listAllSessions, removeSessionDir, type SessionMeta, sessionsDir } from "./session-store";

export async function loadSessionByName(name: string): Promise<SessionMeta | null> {
  for (const m of listAllSessions(sessionsDir())) {
    if (m.name === name) return m;
  }
  return null;
}

async function enrichSession(m: SessionMeta): Promise<SessionWithState> {
  const containerState = await getSandboxState(`${SANDBOX_PREFIX}${m.name}`);
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

export async function reapIdleStaleSessions(): Promise<{
  reaped: string[];
  durationMs: number;
}> {
  const rows = await classifyAll();
  const targets = rows.filter((r) => r.classification === "idle-stale");
  if (targets.length === 0) return { reaped: [], durationMs: 0 };
  const start = Date.now();
  await Promise.all(
    targets.map((r) =>
      stopSandbox(`${SANDBOX_PREFIX}${r.meta.name}`).catch((e: unknown) =>
        console.error(`stop ${r.meta.name}: ${(e as Error).message}`),
      ),
    ),
  );
  return { reaped: targets.map((r) => r.meta.name), durationMs: Date.now() - start };
}

export async function stopSession(name: string): Promise<void> {
  const m = await loadSessionByName(name);
  if (!m) throw new Error(`no such session: ${name}`);
  await stopSandbox(`${SANDBOX_PREFIX}${m.name}`);
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
    const cli = await getCliInvocation();
    const regenArgv = buildOpenshellExecArgv(
      cli.argv,
      containerName,
      ["git", "bundle", "create", "/sandbox/out.bundle", "--all"],
      { workdir: "/sandbox/repo", tty: "off" },
    );
    const regen = Bun.spawn(regenArgv, {
      cwd: cli.cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    await regen.exited;
    const ok = await downloadFromSandbox(containerName, "/sandbox/repo", dest);
    if (!ok) {
      console.warn(`failed to copy /sandbox/repo from ${containerName}; continuing teardown`);
    } else {
      console.log(`copied workspace to ${dest}`);
    }
  }

  // openshell sandbox delete tears down the container and reaps the
  // session-scoped handshake secret + workspace volume in one call.
  await deleteSandbox(containerName);
  await pruneSandboxRefs(opts.hostRepoForRefs ?? m.repoPath, m.name);
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
