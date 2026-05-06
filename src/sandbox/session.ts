import { resolve, join, basename } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { detectCaps, type Cap } from "./detect-caps";
import { resolveOpenlockFolder } from "./openlock-folder";
import { ensureGitRepo, createBundle, fetchBundle } from "./git-sync";
import { startGateway, stopGateway } from "./ensure-gateway";
import { ensureProvider } from "./ensure-provider";
import { prepareGitIdentity } from "./git-identity";
import { saveSession, sessionsDir } from "./session-store";
import { ensureImage } from "./image-build";
import { DEFAULT_CONTAINERFILES, containerfileKeyForCaps } from "./default-containerfiles";
import { getCliInvocation } from "./fork-binaries";

const SANDBOX_PREFIX = "openshell-sandbox-";

interface SandboxOpts {
  path: string;
  name?: string;
  policy?: string;
  keepGateway?: boolean;
}

export function shouldStopGateway(args: { keepGateway?: boolean; otherSandboxes: number }): boolean {
  if (args.keepGateway) return false;
  return args.otherSandboxes === 0;
}

async function openshell(
  args: string[],
  opts?: { stdin?: "inherit"; stdout?: "inherit"; stderr?: "inherit" },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cli = await getCliInvocation();
  const proc = Bun.spawn([...cli.argv, ...args], {
    cwd: cli.cwd,
    stdin: opts?.stdin ?? "ignore",
    stdout: opts?.stdout ?? "pipe",
    stderr: opts?.stderr ?? "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = opts?.stdout === "inherit" ? "" : await new Response(proc.stdout).text();
  const stderr = opts?.stderr === "inherit" ? "" : await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function buildSandboxImage(caps: Cap[]): Promise<string> {
  const key = containerfileKeyForCaps(caps);
  const content = DEFAULT_CONTAINERFILES[key];
  const ref = await ensureImage({
    containerfileContent: content,
    tagPrefix: `openlock-${key}`,
  });
  if (ref.built) {
    console.log(`Built image ${ref.tag}`);
  } else {
    console.log(`Using cached image ${ref.tag}`);
  }
  return ref.tag;
}

export async function runSandbox(opts: SandboxOpts): Promise<void> {
  const projectPath = resolve(opts.path);
  const sessionName = opts.name ?? `${basename(projectPath)}-${Date.now()}`;

  let caps: Cap[];
  let policy: string;
  if (opts.policy) {
    // Explicit --policy flag wins. Skip the .openlock/ folder logic
    // entirely so the flag never has a side effect on repo files.
    caps = detectCaps(projectPath);
    policy = resolve(opts.policy);
  } else {
    const resolved = resolveOpenlockFolder(projectPath);
    caps = resolved.caps;
    policy = resolved.policyPath;
    if (resolved.origin === "first-run") {
      console.log("Created .openlock/. Review and commit before sharing.");
    } else if (resolved.origin === "restored-config") {
      console.log("Restored .openlock/config.yaml.");
    } else if (resolved.origin === "restored-policy") {
      const suffix = caps.length > 0 ? `-${caps.join("-")}` : "";
      console.log(`Restored .openlock/policy.yaml from default${suffix}.yaml.`);
    }
  }
  console.log(`Capabilities: ${caps.length > 0 ? caps.join(", ") : "none"}`);

  await startGateway();
  await ensureProvider();

  const imageTag = await buildSandboxImage(caps);
  console.log(`Policy: ${policy}`);
  console.log(`Image: ${imageTag}`);

  // openshell sandbox create accepts only one --upload. Stage everything
  // into a single dir whose basename becomes the destination subdir on the
  // sandbox side. ".openlock" lands at /sandbox/.openlock.
  await ensureGitRepo(projectPath);
  const tmp = mkdtempSync(join(tmpdir(), "openlock-"));
  try {
    const staging = join(tmp, ".openlock");
    mkdirSync(staging);
    const bundlePath = join(staging, "repo.bundle");
    await createBundle(projectPath, bundlePath);
    console.log("Git bundle created.");

    const gitconfigPath = await prepareGitIdentity(staging);
    console.log(
      gitconfigPath !== null
        ? "Host git identity will be used inside sandbox."
        : "No host git identity found; using sandbox default.",
    );

    console.log(`Creating sandbox "${sessionName}"...`);
    const containerName = `${SANDBOX_PREFIX}${sessionName}`;
    const entryCmd = [
      `cd /sandbox`,
      `if [ -f .openlock/.gitconfig ]; then cp .openlock/.gitconfig .gitconfig; fi`,
      `git clone .openlock/repo.bundle repo`,
      `cd repo`,
      `claude`,
      `git bundle create /sandbox/out.bundle --all 2>/dev/null || true`,
    ].join(" && ");
    const createArgs = [
      "sandbox", "create",
      "--name", sessionName,
      "--from", imageTag,
      "--upload", `${staging}:/sandbox/`,
      "--no-git-ignore",
      "--policy", policy,
      "--provider", "anthropic",
      "--tty",
      "--", "/bin/bash", "-c", entryCmd,
    ];

    const { exitCode } = await openshell(createArgs, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    saveSession(sessionsDir(), {
      name: sessionName,
      path: projectPath,
      caps,
      image: imageTag,
      policy,
      createdAt: new Date().toISOString(),
    });

    console.log("\nSyncing sandbox commits back...");
    const outBundle = join(tmp, "out.bundle");
    try {
      const cp = Bun.spawn(
        ["podman", "cp", `${containerName}:/sandbox/out.bundle`, outBundle],
        { stdout: "pipe", stderr: "pipe" },
      );
      const cpCode = await cp.exited;
      if (cpCode === 0) {
        await fetchBundle(projectPath, outBundle);
        console.log("Sandbox commits synced to remotes/sandbox/*");
      } else {
        console.warn("No commits to sync (sandbox may not have made changes).");
      }
    } catch (e) {
      console.warn(`Sync failed: ${(e as Error).message}`);
    }

    const run = async (cmd: string[]): Promise<string> => {
      const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out.trim();
    };
    await run(["podman", "rm", "-f", containerName]);
    const secrets = (await run(["podman", "secret", "ls", "--format", "{{.Name}}"])).split("\n");
    for (const s of secrets) {
      if (s.startsWith("openshell-handshake-")) await run(["podman", "secret", "rm", s]);
    }
    const volumes = (await run(["podman", "volume", "ls", "--format", "{{.Name}}"])).split("\n");
    for (const v of volumes) {
      if (v.startsWith(SANDBOX_PREFIX) && v.endsWith("-workspace")) await run(["podman", "volume", "rm", v]);
    }

    const stillRunning = (await run([
      "podman", "ps",
      "--format", "{{.Names}}",
      "--filter", `name=${SANDBOX_PREFIX}`,
    ])).split("\n").filter((n) => n.length > 0);
    if (shouldStopGateway({ keepGateway: opts.keepGateway, otherSandboxes: stillRunning.length })) {
      stopGateway();
    } else if (stillRunning.length > 0) {
      console.log(`Gateway kept running (${stillRunning.length} other sandbox(es) active).`);
    } else {
      console.log("Gateway kept running (--keep-gateway).");
    }

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
