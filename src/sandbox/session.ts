import { resolve, join, basename } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { detectCaps, type Cap } from "./detect-caps";
import { resolveOpenlockFolder } from "./openlock-folder";
import { ensureGitRepo, createBundle, fetchBundle } from "./git-sync";
import { startGateway, stopGateway } from "./ensure-gateway";
import { ensureProvider } from "./ensure-provider";
import { prepareGitIdentity } from "./git-identity";
import {
  saveSession,
  sessionsDir,
  findSessionsByPath,
  listAllSessions,
  updateSessionMeta,
  type SessionMeta,
} from "./session-store";
import { ensureImage } from "./image-build";
import { DEFAULT_CONTAINERFILES, containerfileKeyForCaps } from "./default-containerfiles";
import { newSessionId, friendlyNameFromId } from "./identity";
import {
  openshellSandboxCreate,
  inspectContainerState,
  startContainer,
  execClaude,
  copyOutOfContainer,
  listSandboxContainers,
} from "./container";
import { pidAlive } from "./proc";
import { classifySession, type SessionWithState } from "./reap";

export const SANDBOX_PREFIX = "openshell-sandbox-";

export interface SandboxOpts {
  path: string;
  policy?: string;
  keepGateway?: boolean;
}

export function shouldStopGateway(args: { keepGateway?: boolean; otherSandboxes: number }): boolean {
  if (args.keepGateway) return false;
  return args.otherSandboxes === 0;
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

  await ensureGitRepo(projectPath);
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
    const setupCmd = [
      "cd /sandbox",
      "if [ -f .openlock/.gitconfig ]; then cp .openlock/.gitconfig .gitconfig; fi",
      "git clone .openlock/repo.bundle repo",
      "exec sleep infinity",
    ].join(" && ");

    const exitCode = await openshellSandboxCreate({
      sessionName: name,
      imageTag,
      uploadDir: staging,
      policy,
      command: ["/bin/bash", "-c", setupCmd],
    });

    if (exitCode !== 0) {
      throw new Error(`openshell sandbox create exited ${exitCode}`);
    }

    const meta: SessionMeta = {
      id,
      name,
      path: projectPath,
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

async function syncBackToHost(projectPath: string, containerName: string, sessionName: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "openlock-syncback-"));
  try {
    const outBundle = join(tmp, "out.bundle");
    const ok = await copyOutOfContainer(containerName, "/sandbox/out.bundle", outBundle);
    if (ok) {
      await fetchBundle(projectPath, outBundle, sessionName);
      console.log(`Sandbox commits synced to refs/sandbox/${sessionName}/*`);
      return;
    }
    const regen = Bun.spawn(
      ["podman", "exec", containerName, "bash", "-c",
        "cd /sandbox/repo && git bundle create /sandbox/out.bundle --all"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const regenCode = await regen.exited;
    if (regenCode !== 0) {
      console.warn("No commits to sync.");
      return;
    }
    const ok2 = await copyOutOfContainer(containerName, "/sandbox/out.bundle", outBundle);
    if (!ok2) {
      console.warn("No commits to sync.");
      return;
    }
    await fetchBundle(projectPath, outBundle, sessionName);
    console.log(`Sandbox commits synced to refs/sandbox/${sessionName}/*`);
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
  const meta = findSessionByName(sessionName);
  if (meta) {
    updateSessionMeta(sessionsDir(), meta.id, {
      attachedPid: process.pid,
      lastAttachedAt: new Date().toISOString(),
    });
  }
  const exitCode = await execClaude(containerName);
  await syncBackToHost(projectPath, containerName, sessionName);
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

export async function runSandbox(opts: SandboxOpts): Promise<void> {
  const projectPath = resolve(opts.path);

  const matches = findSessionsByPath(sessionsDir(), projectPath);
  if (matches.length > 1) {
    console.error(`Multiple sessions found for ${projectPath}:`);
    for (const m of matches) console.error(`  ${m.name}  (created ${m.createdAt})`);
    console.error("Run `openlock clean <name>` to remove unused sessions.");
    process.exit(2);
  }

  let containerName: string;
  let sessionName: string;
  if (matches.length === 0) {
    const created = await createSession(projectPath, opts);
    containerName = created.containerName;
    sessionName = created.name;
  } else {
    const m = matches[0]!;
    sessionName = m.name;
    containerName = `${SANDBOX_PREFIX}${m.name}`;
    const state = await inspectContainerState(containerName);
    if (state === "missing") {
      console.error(`Session ${m.name} has no container; run \`openlock clean ${m.name}\` to reclaim.`);
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
  }

  const exitCode = await attachClaudeAndSync(containerName, sessionName, projectPath);

  const stillRunning = (await listSandboxContainers(SANDBOX_PREFIX))
    .filter((n) => n !== containerName);
  if (shouldStopGateway({ keepGateway: opts.keepGateway, otherSandboxes: stillRunning.length })) {
    stopGateway();
  } else if (stillRunning.length > 0) {
    console.log(`Gateway kept running (${stillRunning.length} other sandbox(es) active).`);
  } else {
    console.log("Gateway kept running (--keep-gateway).");
  }

  await reportPostRunIdleHint();

  if (exitCode !== 0) process.exit(exitCode);
}
