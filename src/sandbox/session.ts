import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { podmanMachineRunning, podmanSocketActive, runDoctorChecks } from "../doctor";
import { login } from "../login";
import { readToken } from "../tokens";
import { SANDBOX_PREFIX } from "./constants";
import {
  copyOutOfContainer,
  execClaude,
  inspectContainerState,
  listSandboxContainers,
  openshellSandboxCreateAsync,
  startContainer,
  waitForContainerRunning,
} from "./container";
import { containerfileKeyForCaps, DEFAULT_CONTAINERFILES } from "./default-containerfiles";
import { type Cap, detectCaps } from "./detect-caps";
import { startGateway, stopGateway } from "./ensure-gateway";
import { ensureProvider } from "./ensure-provider";
import { ensureRepoIsGit } from "./ensure-repo";
import { prepareGitIdentity } from "./git-identity";
import {
  createBundle,
  fetchBundle,
  formatSyncBackLog,
  promoteActiveBranch,
  pruneSandboxRefs,
  readSandboxActiveBranch,
} from "./git-sync";
import { friendlyNameFromId, newSessionId } from "./identity";
import { ensureImage } from "./image-build";
import { resolveOpenlockFolder } from "./openlock-folder";
import { type PreflightDeps, preflight } from "./preflight";
import { pidAlive } from "./proc";
import { classifySession, type SessionWithState } from "./reap";
import {
  findSessionsByPath,
  listAllSessions,
  type SessionMeta,
  saveSession,
  sessionsDir,
  updateSessionMeta,
} from "./session-store";

export interface SandboxOpts {
  path: string;
  policy?: string;
}

async function buildSandboxImage(caps: Cap[]): Promise<string> {
  const key = containerfileKeyForCaps(caps);
  const content = DEFAULT_CONTAINERFILES[key];
  const ref = await ensureImage({
    containerfileContent: content,
    tagPrefix: `openlock-${key}`,
  });
  console.log(ref.built ? `Built image ${ref.tag}` : `Using cached image ${ref.tag}`);
  return ref.tag;
}

interface ResolvedRepo {
  caps: Cap[];
  policy: string;
}

function resolveRepoPolicyAndCaps(projectPath: string, policyOverride?: string): ResolvedRepo {
  if (policyOverride) {
    return { caps: detectCaps(projectPath), policy: resolve(policyOverride) };
  }
  const folder = resolveOpenlockFolder(projectPath);
  if (folder.origin === "first-run") {
    console.log("Created .openlock/. Review and commit before sharing.");
  } else if (folder.origin === "restored-config") {
    console.log("Restored .openlock/config.yaml.");
  } else if (folder.origin === "restored-policy") {
    const suffix = folder.caps.length > 0 ? `-${folder.caps.join("-")}` : "";
    console.log(`Restored .openlock/policy.yaml from default${suffix}.yaml.`);
  }
  return { caps: folder.caps, policy: folder.policyPath };
}

interface NewSession {
  id: string;
  name: string;
  containerName: string;
  policy: string;
  caps: Cap[];
  image: string;
}

async function createSession(projectPath: string, opts: SandboxOpts): Promise<NewSession> {
  const { caps, policy } = resolveRepoPolicyAndCaps(projectPath, opts.policy);
  console.log(`Capabilities: ${caps.length > 0 ? caps.join(", ") : "none"}`);

  await startGateway();
  await ensureProvider();

  const imageTag = await buildSandboxImage(caps);
  console.log(`Policy: ${policy}`);
  console.log(`Image: ${imageTag}`);

  const id = newSessionId();
  const name = friendlyNameFromId(basename(projectPath), id);
  const containerName = `${SANDBOX_PREFIX}${name}`;

  const tmp = mkdtempSync(join(tmpdir(), "openlock-"));
  try {
    const staging = join(tmp, ".openlock");
    mkdirSync(staging);
    await createBundle(projectPath, join(staging, "repo.bundle"));
    console.log("Git bundle created.");

    const gitconfigPath = await prepareGitIdentity(staging);
    console.log(
      gitconfigPath !== null
        ? "Host git identity will be used inside sandbox."
        : "No host git identity found; using sandbox default.",
    );

    console.log(`Creating sandbox "${name}"...`);
    // Setup runs once at create + on every podman start (idempotent).
    // Final `exec sleep infinity` keeps PID 1 alive so the container
    // outlives the foreground command between attaches.
    const setupCmd = [
      "cd /sandbox",
      "[ -f .openlock/.gitconfig ] && cp .openlock/.gitconfig .gitconfig",
      "[ -d repo ] || git clone .openlock/repo.bundle repo",
      "exec sleep infinity",
    ].join(" ; ");

    const handle = await openshellSandboxCreateAsync({
      sessionName: name,
      imageTag,
      uploadDir: staging,
      policy,
      command: ["/bin/bash", "-c", setupCmd],
    });

    // Don't await handle.exited — it blocks until the container stops.
    // Do detect early failure so we don't write meta for a phantom session.
    const earlyFail = await Promise.race([
      handle.exited.then((code) => ({ early: true as const, code })),
      Bun.sleep(2000).then(() => ({ early: false as const })),
    ]);
    if (earlyFail.early) {
      throw new Error(`openshell sandbox create exited early with code ${earlyFail.code}`);
    }

    await waitForContainerRunning(containerName);

    const meta: SessionMeta = {
      id,
      name,
      repoPath: projectPath,
      caps,
      image: imageTag,
      policy,
      createdAt: new Date().toISOString(),
      lastAttachedAt: null,
      attachedPid: null,
    };
    saveSession(sessionsDir(), meta);

    return { id, name, containerName, policy, caps, image: imageTag };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function syncBackToHost(
  projectPath: string,
  containerName: string,
  sessionName: string,
): Promise<void> {
  // Read the active branch while the container is still running.
  // null = detached HEAD; auto-promote will skip silently.
  const activeBranch = await readSandboxActiveBranch(containerName);

  // Pre-prune: defensive against stale refs from prior sessions reusing
  // this name. The bundle is the source of truth for current refs.
  // Note: if both copy-out paths below fail ("No commits to sync."),
  // prior namespaced refs are already gone. Reachability of any prior
  // tip is preserved via refs/heads/openlock/<session> when auto-promote
  // ran on a previous sync; otherwise the next successful sync recovers.
  await pruneSandboxRefs(projectPath, sessionName);

  const tmp = mkdtempSync(join(tmpdir(), "openlock-syncback-"));
  try {
    const outBundle = join(tmp, "out.bundle");
    // Always regenerate the bundle inside the container before copying it
    // out. Prior implementations preferred a stale /sandbox/out.bundle if
    // one existed, which broke re-attach: a second sync would resurface
    // refs from the first sync only. Run as `sandbox` with cwd
    // /sandbox/repo so git can open the repo (root trips safe.directory)
    // and write /sandbox/out.bundle (owned by sandbox).
    const regen = Bun.spawn(
      [
        "podman",
        "exec",
        "-u",
        "sandbox",
        "-w",
        "/sandbox/repo",
        containerName,
        "git",
        "bundle",
        "create",
        "/sandbox/out.bundle",
        "--all",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const regenCode = await regen.exited;
    if (regenCode !== 0) {
      console.warn("No commits to sync.");
      return;
    }
    const ok = await copyOutOfContainer(containerName, "/sandbox/out.bundle", outBundle);
    if (!ok) {
      console.warn("No commits to sync.");
      return;
    }
    await fetchBundle(projectPath, outBundle, sessionName);

    const promote = await promoteActiveBranch(projectPath, sessionName, activeBranch);
    console.log(formatSyncBackLog(sessionName, activeBranch, promote));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function findSessionByName(name: string): SessionMeta | null {
  for (const m of listAllSessions(sessionsDir())) {
    if (m.name === name) return m;
  }
  return null;
}

async function attachClaudeAndSync(
  containerName: string,
  sessionName: string,
  projectPath: string,
): Promise<number> {
  const exitCode = await execClaude(containerName);
  await syncBackToHost(projectPath, containerName, sessionName);
  const meta = findSessionByName(sessionName);
  if (meta) {
    updateSessionMeta(sessionsDir(), meta.id, {
      attachedPid: null,
      lastAttachedAt: new Date().toISOString(),
    });
  }
  return exitCode;
}

async function reportPostRunIdleHint(): Promise<void> {
  const all = listAllSessions(sessionsDir());
  const now = Date.now();
  let stale = 0;
  for (const m of all) {
    const state = await inspectContainerState(`${SANDBOX_PREFIX}${m.name}`);
    const enriched: SessionWithState = {
      ...m,
      containerState: state,
      pidAlive: pidAlive(m.attachedPid),
    };
    if (classifySession(enriched, now) === "idle-stale") stale += 1;
  }
  if (stale > 0) {
    console.log(`\n${stale} idle session(s) detected. Reap with: openlock reap`);
  }
}

function realPreflightDeps(): PreflightDeps {
  return {
    runDoctorChecks,
    readToken,
    isMac: process.platform === "darwin",
    podmanMachineRunning,
    confirmStartMachine: async () => {
      process.stdout.write("podman machine is not running. Start it now? [Y/n] ");
      const reader = Bun.stdin.stream().getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      const answer = new TextDecoder()
        .decode(value ?? new Uint8Array())
        .trim()
        .toLowerCase();
      return answer === "" || answer === "y" || answer === "yes";
    },
    startPodmanMachine: async () => {
      const proc = Bun.spawn(["podman", "machine", "start"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      return (await proc.exited) === 0;
    },
    podmanSocketActive,
    login,
  };
}

function exitOnPreflightFailure(pre: { ok: boolean; reason?: string }): void {
  if (pre.ok) return;
  console.error(pre.reason ?? "preflight failed");
  process.exit(1);
}

function announceRepoAction(
  action: "existed" | "created" | "inited" | "ensured-commit",
  projectPath: string,
): void {
  if (action === "created") console.log(`Created new project at ${projectPath}`);
  else if (action === "inited") console.log(`Initialized git repository at ${projectPath}`);
  else if (action === "ensured-commit")
    console.log(`Landed empty initial commit in ${projectPath}`);
}

interface ResolvedSession {
  containerName: string;
  sessionName: string;
}

function exitOnAmbiguousSessions(projectPath: string, matches: SessionMeta[]): void {
  if (matches.length <= 1) return;
  console.error(`Multiple sessions found for ${projectPath}:`);
  for (const m of matches) console.error(`  ${m.name}  (created ${m.createdAt})`);
  console.error("Run `openlock clean <name>` to remove unused sessions.");
  process.exit(2);
}

async function reattachSession(m: SessionMeta): Promise<ResolvedSession> {
  const containerName = `${SANDBOX_PREFIX}${m.name}`;
  const state = await inspectContainerState(containerName);
  if (state === "missing") {
    console.error(
      `Session ${m.name} has no container; run \`openlock clean ${m.name}\` to reclaim.`,
    );
    process.exit(1);
  }
  if (pidAlive(m.attachedPid) && m.attachedPid !== process.pid) {
    console.error(`Session ${m.name} is in use by pid ${m.attachedPid}.`);
    process.exit(1);
  }
  if (state === "exited") {
    console.log(`Resuming session ${m.name} (container was stopped)...`);
    await startContainer(containerName);
  } else {
    console.log(`Attaching to running session ${m.name}...`);
  }
  await startGateway();
  await ensureProvider();
  updateSessionMeta(sessionsDir(), m.id, {
    attachedPid: process.pid,
    lastAttachedAt: new Date().toISOString(),
  });
  return { containerName, sessionName: m.name };
}

async function resolveOrCreateSession(
  projectPath: string,
  opts: SandboxOpts,
): Promise<ResolvedSession> {
  const matches = findSessionsByPath(sessionsDir(), projectPath);
  exitOnAmbiguousSessions(projectPath, matches);
  if (matches.length === 0) {
    const created = await createSession(projectPath, opts);
    updateSessionMeta(sessionsDir(), created.id, {
      attachedPid: process.pid,
      lastAttachedAt: new Date().toISOString(),
    });
    return { containerName: created.containerName, sessionName: created.name };
  }
  return reattachSession(matches[0]!);
}

function handleGatewayShutdown(otherCount: number): void {
  if (otherCount === 0) {
    stopGateway();
    return;
  }
  console.log(`Gateway kept running (${otherCount} other sandbox(es) active).`);
}

export async function runSandbox(opts: SandboxOpts): Promise<void> {
  const projectPath = resolve(opts.path);
  const tty = Boolean(process.stdin.isTTY);
  exitOnPreflightFailure(await preflight({ tty, deps: realPreflightDeps() }));
  const repoResult = await ensureRepoIsGit(projectPath);
  announceRepoAction(repoResult.action, projectPath);
  const { containerName, sessionName } = await resolveOrCreateSession(projectPath, opts);
  const exitCode = await attachClaudeAndSync(containerName, sessionName, projectPath);
  const stillRunning = (await listSandboxContainers(SANDBOX_PREFIX)).filter(
    (n) => n !== containerName,
  );
  handleGatewayShutdown(stillRunning.length);
  await reportPostRunIdleHint();
  if (exitCode !== 0) process.exit(exitCode);
}
