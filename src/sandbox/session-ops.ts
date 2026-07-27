import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Runtime } from "../runtime";
import { resolveRuntimeNonInteractive } from "../runtime";
import { deleteSandbox, downloadFromSandbox, getSandboxState, stopSandbox } from "./container";
import { startGateway } from "./ensure-gateway";
import { formatDuration } from "./format";
import { pruneSandboxRefs, syncWorkspaceBundle } from "./git-sync";
import { pidAlive } from "./proc";
import { type Classification, classifySession, reapIdleMs, type SessionWithState } from "./reap";
import { listAllSessions, removeSessionDir, type SessionMeta, sessionsDir } from "./session-store";

export async function loadSessionByName(name: string): Promise<SessionMeta | null> {
  for (const m of listAllSessions(sessionsDir())) {
    if (m.name === name) return m;
  }
  return null;
}

async function enrichSession(m: SessionMeta): Promise<SessionWithState> {
  const containerState = await getSandboxState(m.name);
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
  const idleMs = reapIdleMs();
  for (const m of listAllSessions(sessionsDir())) {
    const state = await enrichSession(m);
    out.push({ meta: m, classification: classifySession(state, now, idleMs), state });
  }
  return out;
}

/** Build the session-end advisory listing OTHER running-unattached sandboxes.
 * Returns null when there are none. No container/podman calls — pure over the
 * already-classified rows. */
export function buildIdleNudge(
  rows: ClassifiedSession[],
  currentName: string,
  nowMs: number,
): string | null {
  const idle = rows.filter(
    (r) =>
      (r.classification === "idle-recent" || r.classification === "idle-stale") &&
      r.meta.name !== currentName,
  );
  if (idle.length === 0) return null;
  const pad = Math.max(...idle.map((r) => r.meta.name.length));
  const lines = idle.map((r) => {
    const basis = r.meta.lastAttachedAt ?? r.meta.createdAt;
    const age = formatDuration(nowMs - new Date(basis).getTime());
    return `  ${r.meta.name.padEnd(pad)}   idle ${age}`;
  });
  const head =
    idle.length === 1
      ? "Note: 1 other idle sandbox is running:"
      : `Note: ${idle.length} other idle sandboxes are running:`;
  return [
    head,
    ...lines,
    "Stop or remove them with `openlock stop <name>` or `openlock clean <name>`.",
  ].join("\n");
}

export interface ReapDeps {
  /** Defaults to classifyAll. Overridable for unit-testing reap ordering
   * without touching real containers. */
  classify?: () => Promise<ClassifiedSession[]>;
  /** Best-effort git-bundle drain run BEFORE stop for each idle-stale
   * session. Defaults to syncWorkspaceBundle. */
  drain?: (
    containerName: string,
    sessionName: string,
    hostRepoSource: string,
    targetDir: string,
  ) => Promise<void>;
  /** Defaults to stopSandbox. */
  stop?: (name: string) => Promise<void>;
}

export async function reapIdleStaleSessions(deps: ReapDeps = {}): Promise<{
  reaped: string[];
  durationMs: number;
}> {
  const classify = deps.classify ?? classifyAll;
  const drain = deps.drain ?? syncWorkspaceBundle;
  const stop = deps.stop ?? stopSandbox;

  const rows = await classify();
  const targets = rows.filter((r) => r.classification === "idle-stale");
  if (targets.length === 0) return { reaped: [], durationMs: 0 };
  console.log(
    `reaping ${targets.length} idle session(s): ${targets.map((r) => r.meta.name).join(", ")}`,
  );
  const start = Date.now();
  await Promise.all(
    targets.map(async (r) => {
      // Drain is best-effort: the container is still running at this point
      // (idle-stale implies running), which is required for git bundle
      // create to work in-container. A failed/blocked drain must never
      // prevent the reap itself.
      try {
        await drain(r.meta.name, r.meta.name, r.meta.repoPath, "/sandbox/repo");
      } catch (e) {
        console.warn(`drain ${r.meta.name}: ${(e as Error).message}`);
      }
      await stop(r.meta.name).catch((e: unknown) =>
        console.error(`stop ${r.meta.name}: ${(e as Error).message}`),
      );
    }),
  );
  return { reaped: targets.map((r) => r.meta.name), durationMs: Date.now() - start };
}

export async function stopSession(name: string): Promise<void> {
  const m = await loadSessionByName(name);
  if (!m) throw new Error(`no such session: ${name}`);
  await stopSandbox(m.name);
  console.log(`stopped ${name}`);
}

export interface GatewaySelfHealDeps {
  /** Defaults to resolveRuntimeNonInteractive. Overridable for testing the
   * no-configured-runtime local-only path without touching real binaries. */
  resolveRuntime?: () => Promise<Runtime | null>;
  /** Defaults to startGateway. Overridable for testing the self-heal branch
   * without spawning a real gateway process. */
  startGateway?: () => Promise<void>;
}

/**
 * Self-heal the gateway (openlock-kx8, ab6 follow-up): several ops
 * (`openshell sandbox delete`/`download`, and — critically — the
 * `sandbox get` calls `classifyAll` makes per session) fail with a raw
 * transport error ("Connection refused") if the gateway is down. Mirrors
 * reattachSession's existing self-heal for the same root cause.
 *
 * Bring-up is attempted ONLY when a runtime is resolvable WITHOUT the
 * interactive wizard (resolveRuntimeNonInteractive never prompts): a box
 * with no configured/detectable runtime has nothing to run a container on,
 * so there is nothing to self-heal for, and forcing startGateway() there
 * would risk blocking on the runtime picker (or failing on unrelated setup —
 * image builds, JWT provisioning) for what should be a pure local
 * session-state cleanup.
 *
 * Returns the resolved runtime (or null when none was resolvable and no
 * bring-up was attempted) so callers can branch on it. Throws when bring-up
 * IS attempted and fails (or startGateway's own hard-failure paths exit the
 * process) — callers must treat that as "nothing done yet, don't proceed."
 *
 * Shared by cleanSession's single-name self-heal AND clean.ts's bulk
 * --all/--stale pre-classification self-heal (see runBulkClean) — same rule,
 * same risk profile, one implementation so the two can't drift apart.
 */
export async function selfHealGatewayIfRuntimeConfigured(
  deps: GatewaySelfHealDeps = {},
): Promise<Runtime | null> {
  const resolveRuntime = deps.resolveRuntime ?? resolveRuntimeNonInteractive;
  const bringUpGateway = deps.startGateway ?? startGateway;
  const runtime = await resolveRuntime();
  if (runtime !== null) {
    await bringUpGateway();
  }
  return runtime;
}

export interface CleanOpts {
  copyDir?: string;
  hostRepoForRefs?: string;
}

export interface CleanDeps extends GatewaySelfHealDeps {
  /** Defaults to deleteSandbox (container.ts). Overridable so tests can
   * assert the local-only/self-heal branching without a real openshell/
   * gateway round trip. */
  deleteSandbox?: (name: string) => Promise<void>;
}

export async function cleanSession(
  name: string,
  opts: CleanOpts = {},
  deps: CleanDeps = {},
): Promise<void> {
  const m = await loadSessionByName(name);
  if (!m) throw new Error(`no such session: ${name}`);
  const containerName = m.name;
  const tearDown = deps.deleteSandbox ?? deleteSandbox;

  const runtime = await selfHealGatewayIfRuntimeConfigured(deps);
  if (runtime === null) {
    // No configured/detectable runtime at all: there is categorically no
    // container that could be running (nothing exists to run it on), and no
    // way for openlock/a gateway to manage one even if it somehow did. Going
    // through the gateway-mediated teardown below would just throw the same
    // transport error deleteSandbox always throws on unreachable-gateway (it
    // only tolerates NotFound) — so skip it and remove the local bookkeeping
    // directly instead of failing on an op that could never have succeeded.
    //
    // This is deliberately NOT the general "gateway unreachable -> assume
    // gone" fallback that was rejected for the runtime-configured case
    // (bare option (b) from openlock-kx8): it only fires when there is
    // provably no runtime to run a container on, never merely because the
    // gateway happens to be down while a runtime (and therefore possibly a
    // real container) exists — that case goes through the normal
    // self-heal-then-delete path above and fails loudly if bring-up fails.
    console.warn(
      `openlock: no container runtime configured/detected; removing local session record for "${name}" without contacting a gateway. If a container from this session still exists, remove it manually.`,
    );
    if (opts.copyDir) {
      // --copy salvages the workspace by reading it out of the sandbox, which
      // needs a runtime and a live gateway. Say so rather than removing the
      // session record while silently honouring nothing: the caller asked to
      // rescue this workspace, and `uninstall.sh --purge` advertises
      // `clean --all --copy <dir>` as the pre-purge salvage route.
      console.warn(
        `openlock: --copy ${opts.copyDir} was NOT honoured for "${name}" — copying the workspace requires a runtime and a reachable gateway. Nothing was written to that path.`,
      );
    }
    await pruneSandboxRefs(opts.hostRepoForRefs ?? m.repoPath, m.name);
    removeSessionDir(sessionsDir(), m.id);
    console.log(`cleaned ${name} (local state only; no runtime configured)`);
    return;
  }

  if (opts.copyDir) {
    const dest = resolve(opts.copyDir);
    rmSync(dest, { recursive: true, force: true });
    const ok = await downloadFromSandbox(containerName, "/sandbox/repo", dest);
    if (!ok) {
      console.warn(`failed to copy /sandbox/repo from ${containerName}; continuing teardown`);
    } else {
      console.log(`copied workspace to ${dest}`);
    }
  }

  // openshell sandbox delete tears down the container and reaps the
  // session-scoped handshake secret + workspace volume in one call.
  await tearDown(containerName);
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
  const classification = classifySession(state, Date.now(), reapIdleMs());
  return { meta: m, state, classification };
}
