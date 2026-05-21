import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { podmanMachineRunning, podmanSocketActive, runDoctorChecks } from "../doctor";
import { readGlobalConfig } from "../global-config";
import { login } from "../login";
import { readToken } from "../tokens";
import { SANDBOX_PREFIX } from "./constants";
import {
  copyOutOfContainer,
  execHarness,
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
import { type Harness, resolveHarness } from "./harness";
import { friendlyNameFromId, newSessionId } from "./identity";
import { ensureImage } from "./image-build";
import {
  bindMountArgs,
  gitBundleMounts,
  type Mount,
  restageMount,
  stageMounts,
  workdirMount,
} from "./mounts";
import { resolveOpenlockFolder } from "./openlock-folder";
import { type PreflightDeps, preflight } from "./preflight";
import { pidAlive } from "./proc";
import { reapIdleStaleSessions } from "./session-ops";
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
  harness?: string;
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
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
}

function resolveRepoPolicyAndCaps(projectPath: string, policyOverride?: string): ResolvedRepo {
  if (policyOverride) {
    return {
      caps: detectCaps(projectPath),
      policy: resolve(policyOverride),
      mounts: [],
      args: [],
      env: {},
    };
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
  return {
    caps: folder.caps,
    policy: folder.policyPath,
    mounts: folder.mounts,
    args: folder.args,
    env: folder.env,
  };
}

interface NewSession {
  id: string;
  name: string;
  containerName: string;
  policy: string;
  caps: Cap[];
  image: string;
}

async function createSession(
  projectPath: string,
  resolved: ResolvedRepo,
  harness: Harness,
): Promise<NewSession> {
  const { caps, policy, mounts } = resolved;
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

    const bundleMounts = gitBundleMounts(mounts);
    const bundlesDir = join(staging, "bundles");
    if (bundleMounts.length > 0) {
      mkdirSync(bundlesDir);
    }
    for (const bm of bundleMounts) {
      const bundleFile = join(bundlesDir, `${basename(bm.source)}.bundle`);
      await createBundle(bm.source, bundleFile);
      console.log(`Git bundle created for ${bm.target}.`);
    }

    stageMounts(staging, mounts);

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
    const wd = workdirMount(mounts);
    const setupLines = [
      "cd /sandbox",
      "[ -f .openlock/.gitconfig ] && cp .openlock/.gitconfig .gitconfig",
    ];
    for (const bm of bundleMounts) {
      const bundleName = `${basename(bm.source)}.bundle`;
      setupLines.push(
        `[ -d ${bm.target} ] || git clone .openlock/bundles/${bundleName} ${bm.target}`,
      );
    }
    if (wd === undefined) {
      setupLines.push("mkdir -p /sandbox/repo");
    }
    setupLines.push("exec sleep infinity");
    const setupCmd = setupLines.join(" ; ");

    const handle = await openshellSandboxCreateAsync({
      sessionName: name,
      imageTag,
      uploadDir: staging,
      policy,
      command: ["/bin/bash", "-c", setupCmd],
      volumeArgs: bindMountArgs(mounts),
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
      harness,
    };
    saveSession(sessionsDir(), meta);

    return { id, name, containerName, policy, caps, image: imageTag };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function syncBackToHost(
  containerName: string,
  sessionName: string,
  mounts: readonly Mount[],
): Promise<void> {
  const wd = workdirMount(mounts);
  if (wd === undefined) {
    console.log("No workdir mount; skipping sync-back.");
    return;
  }
  if (wd.type === "bind") {
    console.log("Bind workdir; no sync-back needed.");
    return;
  }
  if (wd.type !== "git-bundle") {
    // Defense against future relaxation of validateTargetForType permitting
    // copy-* at /sandbox/repo: the bundle/clone flow below assumes a git
    // working tree, not a copy.
    throw new Error(`syncBackToHost: unexpected workdir mount type ${wd.type}`);
  }
  // Read the active branch while the container is still running.
  // null = detached HEAD; auto-promote will skip silently.
  const activeBranch = await readSandboxActiveBranch(containerName, wd.target);

  // Pre-prune: defensive against stale refs from prior sessions reusing
  // this name. The bundle is the source of truth for current refs.
  // Note: if both copy-out paths below fail ("No commits to sync."),
  // prior namespaced refs are already gone. Reachability of any prior
  // tip is preserved via refs/heads/openlock/<session> when auto-promote
  // ran on a previous sync; otherwise the next successful sync recovers.
  await pruneSandboxRefs(wd.source, sessionName);

  const tmp = mkdtempSync(join(tmpdir(), "openlock-syncback-"));
  try {
    const outBundle = join(tmp, "out.bundle");
    // Always regenerate the bundle inside the container before copying it
    // out. Prior implementations preferred a stale /sandbox/out.bundle if
    // one existed, which broke re-attach: a second sync would resurface
    // refs from the first sync only. Run as `sandbox` with cwd wd.target
    // so git can open the repo (root trips safe.directory) and write
    // /sandbox/out.bundle (owned by sandbox).
    const regen = Bun.spawn(
      [
        "podman",
        "exec",
        "-u",
        "sandbox",
        "-w",
        wd.target,
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
    await fetchBundle(wd.source, outBundle, sessionName);

    const promote = await promoteActiveBranch(wd.source, sessionName, activeBranch);
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

interface LaunchOpts {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  harness: Harness;
}

async function attachHarnessAndSync(
  containerName: string,
  sessionName: string,
  launch: LaunchOpts,
  mounts: readonly Mount[],
): Promise<number> {
  const exitCode = await execHarness(launch.harness, containerName, launch.args, launch.env);
  await syncBackToHost(containerName, sessionName, mounts);
  const meta = findSessionByName(sessionName);
  if (meta) {
    updateSessionMeta(sessionsDir(), meta.id, {
      attachedPid: null,
      lastAttachedAt: new Date().toISOString(),
    });
  }
  return exitCode;
}

async function autoReapStaleSessions(): Promise<void> {
  const { reaped, durationMs } = await reapIdleStaleSessions();
  if (reaped.length === 0) return;
  console.log(`\nauto-reaped ${reaped.length} idle session(s) (${durationMs}ms)`);
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

async function reattachSession(m: SessionMeta, mounts: readonly Mount[]): Promise<ResolvedSession> {
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
  for (const mount of mounts) {
    if (mount.type !== "copy-refresh") continue;
    console.log(`Refreshing mount ${mount.target}...`);
    await restageMount(containerName, mount);
  }
  updateSessionMeta(sessionsDir(), m.id, {
    attachedPid: process.pid,
    lastAttachedAt: new Date().toISOString(),
  });
  return { containerName, sessionName: m.name };
}

async function resolveOrCreateSession(
  projectPath: string,
  resolved: ResolvedRepo,
  harness: Harness,
): Promise<ResolvedSession> {
  const matches = findSessionsByPath(sessionsDir(), projectPath);
  exitOnAmbiguousSessions(projectPath, matches);
  if (matches.length === 0) {
    const created = await createSession(projectPath, resolved, harness);
    updateSessionMeta(sessionsDir(), created.id, {
      attachedPid: process.pid,
      lastAttachedAt: new Date().toISOString(),
    });
    return { containerName: created.containerName, sessionName: created.name };
  }
  return reattachSession(matches[0]!, resolved.mounts);
}

/**
 * True iff the user explicitly selected a harness via `--harness` flag or
 * `OPENLOCK_HARNESS` env var. Reattach should NOT reject a session when the
 * user passed nothing and `resolveHarness` falls back to a default that
 * happens to differ from the session's harness.
 */
export function userExplicitlyPickedHarness(args: {
  cliFlag: string | undefined;
  envOpenlockHarness: string | undefined;
}): boolean {
  return Boolean(args.cliFlag) || Boolean(args.envOpenlockHarness);
}

export interface PickSessionHarnessArgs {
  existingSessionHarness: Harness | null;
  userExplicitFlag: string | undefined;
  envOpenlockHarness: string | undefined;
  resolvedHarness: Harness;
}

export interface PickSessionHarnessResult {
  harness: Harness;
  mismatch: boolean;
}

/**
 * Decides which harness to use for a runSandbox invocation given the
 * existing session (if any) and the user's explicit signals.
 *
 * Rules (per Task 6, approach b):
 * 1. If no existing session, use the resolved harness.
 * 2. If an existing session is found AND the user gave NO explicit signal
 *    (`--harness` or `OPENLOCK_HARNESS`), prefer the existing session's harness.
 * 3. If the user passed an explicit signal AND it doesn't match the existing
 *    session's harness, return mismatch=true so callers can reject.
 */
export function pickSessionHarness(args: PickSessionHarnessArgs): PickSessionHarnessResult {
  if (args.existingSessionHarness === null) {
    return { harness: args.resolvedHarness, mismatch: false };
  }
  const explicit = userExplicitlyPickedHarness({
    cliFlag: args.userExplicitFlag,
    envOpenlockHarness: args.envOpenlockHarness,
  });
  if (!explicit) {
    return { harness: args.existingSessionHarness, mismatch: false };
  }
  if (args.existingSessionHarness !== args.resolvedHarness) {
    return { harness: args.resolvedHarness, mismatch: true };
  }
  return { harness: args.resolvedHarness, mismatch: false };
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
  const resolved = resolveRepoPolicyAndCaps(projectPath, opts.policy);

  // Decide the effective harness BEFORE create-or-reattach so we can persist
  // the right value on first create and reject explicit mismatches on reattach.
  const existingMatches = findSessionsByPath(sessionsDir(), projectPath);
  exitOnAmbiguousSessions(projectPath, existingMatches);
  const resolvedHarness = resolveHarness({
    cliFlag: opts.harness,
    env: process.env,
    readGlobal: readGlobalConfig,
  });
  const pick = pickSessionHarness({
    existingSessionHarness: existingMatches[0]?.harness ?? null,
    userExplicitFlag: opts.harness,
    envOpenlockHarness: process.env.OPENLOCK_HARNESS,
    resolvedHarness,
  });
  if (pick.mismatch) {
    const existing = existingMatches[0]!;
    console.error(
      `Session ${existing.name} was created with harness ${existing.harness}; ` +
        `requested harness ${pick.harness} does not match. ` +
        `Create a new session or omit --harness.`,
    );
    process.exit(1);
  }
  const harness = pick.harness;

  const { containerName, sessionName } = await resolveOrCreateSession(
    projectPath,
    resolved,
    harness,
  );
  const launch: LaunchOpts = { args: resolved.args, env: resolved.env, harness };
  const exitCode = await attachHarnessAndSync(containerName, sessionName, launch, resolved.mounts);
  const stillRunning = (await listSandboxContainers(SANDBOX_PREFIX)).filter(
    (n) => n !== containerName,
  );
  handleGatewayShutdown(stillRunning.length);
  await autoReapStaleSessions();
  if (exitCode !== 0) process.exit(exitCode);
}
