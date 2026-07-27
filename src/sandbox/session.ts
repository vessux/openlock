import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CredentialBundle } from "../config-core";
import {
  dockerDaemonReachable,
  podmanMachineRunning,
  podmanSocketActive,
  runDoctorChecks,
} from "../doctor";
import { readGlobalConfig } from "../global-config";
import { login } from "../login";
import { PROVIDERS } from "../providers/registry";
import { resolveProvider } from "../providers/resolve";
import type { ProviderId, SandboxFile } from "../providers/types";
import { type Runtime, resolveRuntime } from "../runtime";
import { hasAnyProvider } from "../tokens";
import { validateBranchFlagAgainstWorkdir } from "./branch-validation";
import {
  assertSandboxNotExited,
  buildOpenshellExecArgv,
  buildSandboxEnv,
  deleteSandbox,
  execHarness,
  getSandboxState,
  openshellSandboxCreateAsync,
  startSandbox,
  waitForSandboxReady,
} from "./container";
import { resolveCredentialValues } from "./credentials";
import {
  computeBuildInputsHashFromFiles,
  decideReattachAction,
  type ReattachAction,
} from "./drift";
import { startGateway, stopGateway } from "./ensure-gateway";
import { ensureGenericProvider, ensureProvider } from "./ensure-provider";
import { ensureRepoIsGit } from "./ensure-repo";
import { getCliInvocation } from "./fork-binaries";
import { prepareGitIdentity } from "./git-identity";
import { createBundle, syncWorkspaceBundle } from "./git-sync";
import { type Harness, resolveHarness } from "./harness";
import { friendlyNameFromId, newSessionId } from "./identity";
import { ensureSandbox } from "./image-build";
import {
  bindMountArgs,
  gitBundleMounts,
  type Mount,
  restageMount,
  stageMounts,
  stagingPathFor,
  workdirMount,
} from "./mounts";
import { resolveOpenlockFolder } from "./openlock-folder";
import { type PreflightDeps, preflight } from "./preflight";
import { pidAlive } from "./proc";
import { heartbeatIntervalMs, reapIdleMs } from "./reap";
import { buildIdleNudge, classifyAll, cleanSession, reapIdleStaleSessions } from "./session-ops";
import {
  findSessionsByPath,
  listAllSessions,
  type SessionMeta,
  saveSession,
  sessionsDir,
  updateSessionMeta,
} from "./session-store";
import {
  decideTlsFallbackAction,
  fetchTlsFallbackVerdict,
  formatTlsFallbackBlockedMessage,
  formatTlsFallbackUnknownWarning,
} from "./tls-state";

export interface SandboxOpts {
  path: string;
  policy?: string;
  harness?: string;
  provider?: string;
  branch?: string;
  /** Detached create: create/resolve the session but do NOT attach the harness,
   * so a scripted/CI caller can drive it via `openlock exec`. */
  noAttach?: boolean;
  /** Opt-in supervisor debug for L7 egress header capture (see container.ts).
   * Applies only at container creation; ignored when reattaching an existing one. */
  debugEgress?: boolean;
  /** Force a fresh sandbox-image build (--no-cache + --pull), bypassing the
   * cached-image short-circuit. Refreshes a mutable third-party FROM tag whose
   * Containerfile text (and thus hash) is unchanged. On reattach it is honored
   * too: the existing session is torn down and recreated (see resolveOrCreateSession). */
  rebuild?: boolean;
}

async function buildSandboxImage(openlockFolderPath: string, rebuild: boolean): Promise<string> {
  const cfPath = join(openlockFolderPath, "Containerfile");
  const userContent = readFileSync(cfPath, "utf-8");
  const tag = await ensureSandbox(userContent, { rebuild });
  console.log(`Sandbox image ${tag}`);
  return tag;
}

interface ResolvedRepo {
  policy: string;
  mounts: Mount[];
  args: string[];
  env: Record<string, string>;
  credentials: CredentialBundle[];
  /** Harness persisted in the project's .openlock/config.yaml, if any. Feeds
   * resolveHarness so `openlock init --harness X` carries into later `sandbox`
   * runs. Absent on the --policy override path (no .openlock/ is read). */
  harness?: Harness;
}

export function resolveRepoPolicy(projectPath: string, policyOverride?: string): ResolvedRepo {
  if (policyOverride) {
    return {
      policy: resolve(policyOverride),
      mounts: [],
      args: [],
      env: {},
      credentials: [],
    };
  }
  const folder = resolveOpenlockFolder(projectPath);
  const repo: ResolvedRepo = {
    policy: folder.policyPath,
    mounts: folder.mounts,
    args: folder.args,
    env: folder.env,
    credentials: folder.credentials,
  };
  if (folder.harness !== undefined) repo.harness = folder.harness;
  return repo;
}

/** Hash of the container's "cold" build inputs (Containerfile + mounts + policy
 * content) for the current `.openlock/` config — the same computation at create
 * and reattach, so drift is detected by a plain string compare. */
function sessionBuildInputsHash(projectPath: string, resolved: ResolvedRepo): string | undefined {
  return computeBuildInputsHashFromFiles(
    join(projectPath, ".openlock", "Containerfile"),
    resolved.mounts,
    resolved.policy,
  );
}

interface NewSession {
  id: string;
  name: string;
  containerName: string;
  policy: string;
  image: string;
}

// Provider-supplied files (e.g. anthropic's dummy OAuth .credentials.json)
// land under /sandbox/.openlock/. The staging dir IS the uploaded .openlock,
// so we derive the staging-relative path via stagingPathFor — the SAME
// hardened guard stageMounts uses (absolute + no '..' segments + prefix),
// which prevents a provider writing outside .openlock (a bare prefix check
// would let `/sandbox/.openlock/../../etc/foo` escape on write). Exported for
// unit-testing the traversal rejection.
export function stageProviderSandboxFiles(staging: string, files: readonly SandboxFile[]): void {
  for (const f of files) {
    const rel = stagingPathFor(f.sandboxPath);
    const dest = join(staging, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content, { mode: 0o600 });
  }
}

/** POSIX single-quote a value for safe embedding in a `bash -c` string. */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the `bash -c` setup script run as the sandbox container's initial
 * command. Runs once at create and on every podman start (idempotent); the
 * final `exec sleep infinity` keeps PID 1 alive so the container outlives the
 * foreground command between attaches. /sandbox/repo itself is provisioned in
 * the image (RUN mkdir) so it exists before openshell's PID 1 chdir.
 *
 * SECURITY: mount `target`/`source` values come from .openlock/config.yaml and
 * are attacker-controllable via a cloned/shared repo. They are single-quoted
 * (shq) so a crafted value like `/sandbox/.openlock/x$(...)` cannot inject
 * shell commands at create time (manifest validation also rejects shell
 * metacharacters in targets — this is the defense-in-depth second layer).
 * Exported for regression testing.
 */
export function buildSetupCmd(bundleMounts: readonly Mount[], branch: string | undefined): string {
  const setupLines = [
    "cd /sandbox",
    "[ -f .openlock/.gitconfig ] && cp .openlock/.gitconfig .gitconfig",
    // Claude Code's CLAUDE_CONFIG_DIR must be writable by the sandbox user.
    // The anthropic provider normally stages .credentials.json into
    // .openlock/claude-config/ host-side (stageProviderSandboxFiles calls
    // mkdirSync on the parent), so the dir exists before the container starts.
    // This mkdir + chown runs unconditionally to: (a) normalize ownership to
    // the sandbox user after host-side upload, and (b) cover harnesses or
    // providers that stage no file there. `|| true` keeps it non-fatal.
    "mkdir -p .openlock/claude-config && chown -R sandbox:sandbox .openlock/claude-config 2>/dev/null || true",
  ];
  for (const bm of bundleMounts) {
    const bundleName = `${basename(bm.source)}.bundle`;
    const isWorkdir = bm.target === "/sandbox/repo";
    const branchFlag = isWorkdir && branch !== undefined ? `-b ${shq(branch)} ` : "";
    setupLines.push(
      `[ -d ${shq(bm.target)}/.git ] || git clone ${branchFlag}${shq(`.openlock/bundles/${bundleName}`)} ${shq(bm.target)}`,
    );
  }
  setupLines.push("exec sleep infinity");
  return setupLines.join(" ; ");
}

async function createSession(
  projectPath: string,
  resolved: ResolvedRepo,
  harness: Harness,
  providerId: ProviderId,
  branch: string | undefined,
  debugEgress: boolean,
  rebuild: boolean,
): Promise<NewSession> {
  const { policy, mounts } = resolved;

  await startGateway();
  await ensureProvider(providerId);

  const attachProviders: string[] = [];
  for (const bundle of resolved.credentials) {
    const values = resolveCredentialValues(bundle, process.env);
    await ensureGenericProvider(bundle.name, values);
    attachProviders.push(bundle.name);
  }

  const imageTag = await buildSandboxImage(join(projectPath, ".openlock"), rebuild);
  console.log(`Policy: ${policy}`);
  console.log(`Image: ${imageTag}`);

  const id = newSessionId();
  const name = friendlyNameFromId(basename(projectPath), id);
  // openshell registers the sandbox under its CLI --name; the podman container
  // happens to be named `openshell-sandbox-<name>` but openshell verbs
  // (get/exec/stop/start/delete) take the gateway name (unprefixed).
  const containerName = name;

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
    stageProviderSandboxFiles(staging, PROVIDERS[providerId].sandboxFiles(harness));

    const gitconfigPath = await prepareGitIdentity(staging);
    console.log(
      gitconfigPath !== null
        ? "Host git identity will be used inside sandbox."
        : "No host git identity found; using sandbox default.",
    );

    console.log(`Creating sandbox "${name}"...`);
    // Setup runs once at create + on every podman start (idempotent).
    const setupCmd = buildSetupCmd(bundleMounts, branch);

    // openshell's supervisor can transiently report Error during first-handshake
    // (Provisioning→Error→Provisioning within ~20ms on cold gateway) and exit
    // the create command before recovering. Retry once on early-fail before
    // surfacing to the user. See bd openlock-bxm.
    const MAX_CREATE_ATTEMPTS = 2;
    let lastExitCode: number | null = null;
    let createdOk = false;
    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
      const handle = await openshellSandboxCreateAsync({
        sessionName: name,
        imageTag,
        uploadDir: staging,
        policy,
        providerId,
        command: ["/bin/bash", "-c", setupCmd],
        volumeArgs: bindMountArgs(mounts),
        debugEgress,
        attachProviders,
      });

      // Don't await handle.exited — it blocks until the container stops.
      // Do detect early failure so we don't write meta for a phantom session.
      const earlyFail = await Promise.race([
        handle.exited.then((code) => ({ early: true as const, code })),
        Bun.sleep(2000).then(() => ({ early: false as const })),
      ]);
      if (!earlyFail.early) {
        createdOk = true;
        break;
      }
      lastExitCode = earlyFail.code;
      if (attempt < MAX_CREATE_ATTEMPTS) {
        console.warn(
          `openshell sandbox create exited early (code ${earlyFail.code}); retrying once (supervisor first-handshake race)...`,
        );
        await deleteSandbox(containerName);
        await Bun.sleep(1000);
      }
    }
    if (!createdOk) {
      throw new Error(
        `openshell sandbox create exited early with code ${lastExitCode} after ${MAX_CREATE_ATTEMPTS} attempts`,
      );
    }

    await waitForStagingUploaded(containerName, staging);
    await waitForSandboxReady(name);

    const meta: SessionMeta = {
      id,
      name,
      repoPath: projectPath,
      image: imageTag,
      policy,
      createdAt: new Date().toISOString(),
      lastAttachedAt: null,
      attachedPid: null,
      harness,
      buildInputsHash: sessionBuildInputsHash(projectPath, resolved),
    };
    saveSession(sessionsDir(), meta);

    return { id, name, containerName, policy, image: imageTag };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// openshell sandbox create uploads --upload contents asynchronously; the
// staging tmp dir is removed in finally once createSession returns. Without
// this wait the rmSync races the upload and openshell errors with
// "local path does not exist". Empty staging short-circuits (nothing to wait for).
async function waitForStagingUploaded(
  containerName: string,
  stagingDir: string,
  timeoutMs = 30_000,
): Promise<void> {
  const entries = readdirSync(stagingDir);
  if (entries.length === 0) return;
  const sentinel = entries[0]!;
  const deadline = Date.now() + timeoutMs;
  const cli = await getCliInvocation();
  const argv = buildOpenshellExecArgv(
    cli.argv,
    containerName,
    ["test", "-e", `/sandbox/.openlock/${sentinel}`],
    { tty: "off" },
  );
  while (Date.now() < deadline) {
    const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) === 0) return;
    // Fail fast with the real cause if the container has already died (e.g.
    // supervisor policy-fetch failure) instead of spending the rest of this
    // timeout only to fall through to the misleading warning below.
    await assertSandboxNotExited(containerName);
    await Bun.sleep(200);
  }
  console.warn(
    `staging upload to /sandbox/.openlock/${sentinel} not visible within ${timeoutMs}ms`,
  );
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
  await syncWorkspaceBundle(containerName, sessionName, wd.source, wd.target);
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

// While the harness is attached, lastAttachedAt is otherwise only stamped at
// attach/reattach/harness-exit. If the CLI process is killed mid-session,
// attachedPid's pidAlive flips false and the session is judged by that stale
// timestamp — possibly landing on idle-stale (and getting reaped) instantly
// even though the container was actively in use. Refresh it periodically
// while attached so a killed CLI still gets the full idle grace window.
// Only runs when reaping is on (idleMs !== null) — no point writing to disk
// every interval when nothing will ever act on it.
function startAttachHeartbeat(sessionName: string): ReturnType<typeof setInterval> | undefined {
  const idleMs = reapIdleMs();
  if (idleMs === null) return undefined;
  return setInterval(() => {
    try {
      const meta = findSessionByName(sessionName);
      if (meta) {
        updateSessionMeta(sessionsDir(), meta.id, { lastAttachedAt: new Date().toISOString() });
      }
    } catch (e) {
      // A swallowed/logged heartbeat error must never crash the session.
      console.error(
        `heartbeat update failed for ${sessionName}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, heartbeatIntervalMs(idleMs));
}

async function attachHarnessAndSync(
  containerName: string,
  sessionName: string,
  launch: LaunchOpts,
  mounts: readonly Mount[],
): Promise<number> {
  const heartbeat = startAttachHeartbeat(sessionName);
  let exitCode: number;
  try {
    exitCode = await execHarness(launch.harness, sessionName, launch.args, launch.env);
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
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

/** On session end: if reaping is off (default), print an advisory nudge about
 * other idle sandboxes; otherwise reap idle-stale sessions and log what stopped.
 * Replaces the old silent global reap (openlock-rdh / GH #76). */
async function autoReapOrNudge(currentSessionName: string): Promise<void> {
  if (reapIdleMs() === null) {
    const rows = await classifyAll();
    const msg = buildIdleNudge(rows, currentSessionName, Date.now());
    if (msg) console.log(`\n${msg}`);
    return;
  }
  const { reaped, durationMs } = await reapIdleStaleSessions();
  if (reaped.length === 0) return;
  console.log(`\nauto-reaped ${reaped.length} idle session(s) (${durationMs}ms)`);
}

// Host-bootstrap helper: ensures the underlying container runtime daemon is
// reachable. Runtime-aware so the docker case doesn't try to `podman machine
// start`. Linux skips entirely (no machine layer for either runtime — the
// daemon is a system service the user manages).
async function ensureHostRuntimeReady(): Promise<void> {
  if (process.platform !== "darwin") return;
  const runtime = await resolveRuntime();
  if (runtime === "podman") {
    const proc = Bun.spawn(["podman", "machine", "start"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error("podman machine start failed. See output above.");
    }
    return;
  }
  // Docker Desktop on Mac: assume the user has it running. We deliberately do
  // NOT try to launch Docker Desktop (GUI startup is async and unreliable to
  // wait on). `docker info` is the canonical liveness probe.
  const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error("Docker Desktop does not appear to be running. Open Docker Desktop and retry.");
  }
}

function realPreflightDeps(runtime: Runtime): PreflightDeps {
  return {
    runDoctorChecks: () => runDoctorChecks(runtime),
    hasCredentials: hasAnyProvider,
    isMac: process.platform === "darwin",
    runtime,
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
    ensureHostRuntimeReady: async () => {
      try {
        await ensureHostRuntimeReady();
        return true;
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return false;
      }
    },
    podmanSocketActive,
    dockerDaemonReachable,
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

/** Refuse to touch a session another live process is attached to. Applies to
 * both reattach and the drift-triggered recreate (which tears the container
 * down) — a concurrent `openlock sandbox` on the same repo must not yank the
 * container out from under an attached session. */
function exitIfSessionInUse(m: SessionMeta): void {
  if (pidAlive(m.attachedPid) && m.attachedPid !== process.pid) {
    console.error(`Session ${m.name} is in use by pid ${m.attachedPid}.`);
    process.exit(1);
  }
}

async function reattachSession(
  m: SessionMeta,
  mounts: readonly Mount[],
  providerId: ProviderId,
  credentials: readonly CredentialBundle[],
): Promise<ResolvedSession> {
  const containerName = m.name;
  // Self-heal (openlock-ab6): getSandboxState queries the gateway
  // (`openshell sandbox get`), so a dead/never-started gateway makes a
  // perfectly healthy container look "missing" (transport error, not a real
  // NotFound) — start/reuse the gateway FIRST so the state query below
  // reflects reality instead of a false "no container".
  await startGateway();
  const state = await getSandboxState(containerName);
  if (state === "missing") {
    console.error(
      `Session ${m.name} has no container; run \`openlock clean ${m.name}\` to reclaim.`,
    );
    process.exit(1);
  }
  exitIfSessionInUse(m);
  // "exited" (Failed/Exited) and "stopped" (an intentional `openlock stop`)
  // both need an explicit resume start; only "running"/"other" are already
  // up. Kept as one combined check (rather than switching the message/start
  // gate to "stopped" alone) so a genuinely-dead container still gets a
  // resume attempt, matching pre-openlock-weo behavior.
  const needsStart = state === "exited" || state === "stopped";
  if (needsStart) {
    console.log(`Resuming session ${m.name} (container was stopped)...`);
  } else {
    console.log(`Attaching to running session ${m.name}...`);
  }
  await ensureProvider(providerId);
  // Re-provision (not re-attach — the sandbox's --provider set is fixed at
  // create) each declared bundle, since the gateway may have restarted since
  // this session was created and lost its provider records.
  for (const bundle of credentials) {
    await ensureGenericProvider(bundle.name, resolveCredentialValues(bundle, process.env));
  }
  if (needsStart) {
    await startSandbox(containerName);
    // The gateway derives phase from observed driver state gated on a
    // container healthcheck, so phase can still read Stopped for up to ~35s
    // (observed) after StartSandbox already returned success and the
    // container is Up (openlock-weo) — consistent with either the
    // healthcheck cadence or the gateway's reconcile sweep; not
    // disambiguated. Tolerate that lag — but only here, right after we
    // issued the start ourselves — and give it a longer budget so a
    // slightly slower observation doesn't just move the same false-negative
    // later.
    await waitForSandboxReady(m.name, { tolerateStopped: true, timeoutMs: 90_000 });
  } else {
    await waitForSandboxReady(m.name);
  }
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

/** Blocking y/N prompt shown on reattach when the sandbox's cold build inputs
 * drifted. Default (empty answer) is No — never destroy the container unasked. */
async function promptRebuildOnDrift(name: string): Promise<boolean> {
  process.stdout.write(
    `openlock: .openlock config/policy changed since sandbox "${name}" was built. Rebuild it now? [y/N] `,
  );
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const answer = new TextDecoder()
    .decode(value ?? new Uint8Array())
    .trim()
    .toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Blocking y/N prompt shown when TLS termination is confirmed disabled (bd
 * openlock-bj2): the in-container proxy is running with ZERO L7 enforcement.
 * Default (empty answer) is No — never silently run a session with the
 * credential/content moat off. Mirrors promptRebuildOnDrift's UX. */
async function promptProceedWithTlsDisabled(name: string): Promise<boolean> {
  process.stdout.write(
    `Proceed anyway with sandbox "${name}" running WITHOUT L7 credential/content enforcement? [y/N] `,
  );
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const answer = new TextDecoder()
    .decode(value ?? new Uint8Array())
    .trim()
    .toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * Post-ready health assertion (bd openlock-bj2): the fork's in-container
 * proxy falls back to a raw byte tunnel — no cred_inject, no allowed_secrets
 * scoping, no content policy — when its ephemeral TLS CA fails to
 * generate/write at supervisor startup. That's a cold-start-only failure
 * mode, but exactly the rootless-podman/uid-remap/mount-permission class this
 * project hits repeatedly, and it is otherwise silent: the supervisor logs a
 * Medium OCSF event and moves on. Runs once create/reattach/recreate have all
 * converged on a Ready container (resolveOrCreateSession only returns once
 * waitForSandboxReady succeeded down whichever path it took), before any
 * harness or `exec` touches the session. Exits the process on a confirmed or
 * user-declined block.
 */
async function enforceTlsTerminationHealthy(name: string, interactive: boolean): Promise<void> {
  const verdict = await fetchTlsFallbackVerdict(name);
  const action = decideTlsFallbackAction({ verdict, interactive });
  if (action === "proceed") return;
  if (action === "warn-unknown") {
    console.warn(formatTlsFallbackUnknownWarning(name));
    return;
  }
  console.error(formatTlsFallbackBlockedMessage(name));
  if (action === "prompt" && (await promptProceedWithTlsDisabled(name))) {
    console.warn(
      `openlock: proceeding with sandbox "${name}" — L7 credential/content enforcement is DISABLED.`,
    );
    return;
  }
  process.exit(1);
}

/** Tear down a drifted session and create a fresh one from the current config.
 * Mirrors `openlock clean` + a fresh create; the session gets a new name/id. */
async function recreateSession(
  m: SessionMeta,
  projectPath: string,
  resolved: ResolvedRepo,
  harness: Harness,
  providerId: ProviderId,
  branch: string | undefined,
  debugEgress: boolean,
  rebuild: boolean,
): Promise<ResolvedSession> {
  await startGateway(); // cleanSession → deleteSandbox routes through the gateway
  await cleanSession(m.name);
  const created = await createSession(
    projectPath,
    resolved,
    harness,
    providerId,
    branch,
    debugEgress,
    rebuild,
  );
  updateSessionMeta(sessionsDir(), created.id, {
    attachedPid: process.pid,
    lastAttachedAt: new Date().toISOString(),
  });
  return { containerName: created.containerName, sessionName: created.name };
}

async function resolveOrCreateSession(
  projectPath: string,
  resolved: ResolvedRepo,
  harness: Harness,
  providerId: ProviderId,
  branch: string | undefined,
  debugEgress: boolean,
  rebuild: boolean,
  interactive: boolean,
): Promise<ResolvedSession> {
  const matches = findSessionsByPath(sessionsDir(), projectPath);
  exitOnAmbiguousSessions(projectPath, matches);
  if (matches.length === 0) {
    const created = await createSession(
      projectPath,
      resolved,
      harness,
      providerId,
      branch,
      debugEgress,
      rebuild,
    );
    updateSessionMeta(sessionsDir(), created.id, {
      attachedPid: process.pid,
      lastAttachedAt: new Date().toISOString(),
    });
    return { containerName: created.containerName, sessionName: created.name };
  }

  // Reattach path. Detect drift of the container's cold build inputs
  // (Containerfile + mounts + policy) vs. the current .openlock config: those
  // can't be hot-applied to a running container, only a recreate honors them.
  const m = matches[0]!;
  // Guard up front: both the attach and the drift-triggered recreate must
  // refuse a session another live process holds (recreate would delete it).
  exitIfSessionInUse(m);
  // undefined ⇒ can't read the current Containerfile/policy (they'd have to
  // have vanished since create); decideReattachAction treats that as
  // "can't compare, proceed" unless --rebuild forces a recreate anyway.
  const currentHash = sessionBuildInputsHash(projectPath, resolved);
  const action: ReattachAction = decideReattachAction({
    storedHash: m.buildInputsHash,
    currentHash,
    rebuildFlag: rebuild,
    interactive,
  });

  if (action === "warn-stale") {
    console.warn(
      `openlock: .openlock config/policy changed since sandbox "${m.name}" was built; ` +
        "attaching the existing container unchanged. Re-run with --rebuild to apply the changes (recreates the sandbox).",
    );
  }

  const attachStale = () => reattachSession(m, resolved.mounts, providerId, resolved.credentials);

  if (action === "proceed" || action === "warn-stale") return attachStale();

  if (action === "prompt" && !(await promptRebuildOnDrift(m.name))) {
    console.log(
      `Keeping existing sandbox "${m.name}"; changes not applied. Re-run with --rebuild to apply them later.`,
    );
    return attachStale();
  }

  // action === "rebuild", or the prompt was answered yes.
  console.log(`Rebuilding sandbox "${m.name}" to apply config/policy changes...`);
  return recreateSession(
    m,
    projectPath,
    resolved,
    harness,
    providerId,
    branch,
    debugEgress,
    rebuild,
  );
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

function handleGatewayShutdown(remainingSessions: number): void {
  // Keep the gateway alive while any openlock session metadata exists
  // (running OR stopped). Stopped sessions still need `openlock
  // exec|stop|clean` to reach the gateway; the gateway DB rebinds them on
  // next start. Tearing gateway down between commands was openlock-ne9.
  if (remainingSessions === 0) {
    stopGateway();
    return;
  }
  console.log(`Gateway kept running (${remainingSessions} session(s) remain).`);
}

export async function runSandbox(opts: SandboxOpts): Promise<void> {
  const projectPath = resolve(opts.path);
  const tty = Boolean(process.stdin.isTTY);
  const runtime = await resolveRuntime();
  exitOnPreflightFailure(await preflight({ tty, deps: realPreflightDeps(runtime) }));
  const repoResult = await ensureRepoIsGit(projectPath);
  announceRepoAction(repoResult.action, projectPath);
  let resolved: ResolvedRepo;
  try {
    resolved = resolveRepoPolicy(projectPath, opts.policy);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const branchErr = validateBranchFlagAgainstWorkdir(opts.branch, workdirMount(resolved.mounts));
  if (branchErr !== null) {
    console.error(branchErr);
    process.exit(2);
  }

  // Decide the effective harness BEFORE create-or-reattach so we can persist
  // the right value on first create and reject explicit mismatches on reattach.
  const existingMatches = findSessionsByPath(sessionsDir(), projectPath);
  exitOnAmbiguousSessions(projectPath, existingMatches);
  const resolvedHarness = resolveHarness({
    cliFlag: opts.harness,
    env: process.env,
    projectHarness: resolved.harness,
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

  const providerId: ProviderId = resolveProvider({
    harness,
    cliFlag: opts.provider,
    env: process.env,
    readGlobalConfig,
  });

  const { containerName, sessionName } = await resolveOrCreateSession(
    projectPath,
    resolved,
    harness,
    providerId,
    opts.branch,
    opts.debugEgress === true,
    opts.rebuild === true,
    tty,
  );

  // Convergence point for create / reattach / drift-triggered recreate: all
  // three paths inside resolveOrCreateSession only return once the container
  // reported Ready. Check exactly once here, before either attach mode.
  await enforceTlsTerminationHealthy(containerName, tty);

  if (opts.noAttach === true) {
    // Detached create: the persistent container is up (the sleep-infinity
    // tether), so skip attaching the harness — a scripted/CI caller drives it
    // via `openlock exec <name> -- <cmd>`. resolveOrCreateSession stamped this
    // CLI's pid as attachedPid; reset the meta to never-attached so (a) the dead
    // pid can't trigger a false "in use by pid" rejection on PID reuse, and
    // (b) classifySession returns idle-recent (lastAttachedAt: null) so the
    // detached session is NOT auto-reaped while it waits to be exec'd. Keep the
    // gateway alive (>=1 session) and exit cleanly: the tether + gateway client
    // otherwise keep the compiled-bun event loop from draining (see openlock-to9).
    const meta = findSessionByName(sessionName);
    if (meta) {
      updateSessionMeta(sessionsDir(), meta.id, { attachedPid: null, lastAttachedAt: null });
    }
    console.log(`Session ${sessionName} created (detached, harness not attached).`);
    console.log(`Run a command with:  openlock exec ${sessionName} -- <cmd>`);
    await autoReapOrNudge(sessionName);
    handleGatewayShutdown(listAllSessions(sessionsDir()).length);
    process.exit(0);
  }

  const launch: LaunchOpts = {
    args: resolved.args,
    env: buildSandboxEnv({ providerId, harness, repoConfigEnv: resolved.env }),
    harness,
  };
  const exitCode = await attachHarnessAndSync(containerName, sessionName, launch, resolved.mounts);
  handleGatewayShutdown(listAllSessions(sessionsDir()).length);
  await autoReapOrNudge(sessionName);
  // Exit explicitly with the harness's code. The persistent-container tether
  // (openshellSandboxCreateAsync's `openshell sandbox create … sleep infinity`
  // child) and the gateway client are intentionally left running, so the
  // compiled-bun event loop never drains and the CLI would otherwise hang here
  // after the harness exits (it hung only on the compiled binary; `bun run`
  // auto-exits, which masked it). See openlock-to9.
  process.exit(exitCode);
}
