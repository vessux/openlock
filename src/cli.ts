#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { computeBaseTag } from "./sandbox/ensure-base";
import { BASE_CONTAINERFILE } from "./sandbox/image-build";

// Replaced with the build commit SHA via `bun build --define` in release CI;
// undefined for local/dev runs (guarded with `typeof` at the use site).
declare const OPENLOCK_BUILD_SHA: string;

const USAGE = `
openlock - sandbox orchestration toolkit

Usage: openlock <command>

Getting started:
  setup              Configure machine defaults (runtime, harness, provider)
  init [path]        Scaffold .openlock/ for a project (interactive)

Session lifecycle:
  sandbox [path]     Create or resume a sandbox session (path defaults to cwd; runs preflight; requires .openlock/ — run \`openlock init\` first)
  list               List all sessions
  status [name]      Show session metadata + container state
  stop [name]        Stop session containers (preserves state)
  clean [name]       Tear down session (rm container + state + host refs)
  reap               Stop idle sessions (no removal)
  shell [name]       Open bash inside the session container
  exec [name] -- ... Run a command inside the session container
  logs [name]        Tail the in-sandbox proxy egress log (L7 allow/deny decisions)

Other:
  cred-refresh       Start the credential refresh service
  login              Authenticate with the gateway
  logout             Remove stored provider credentials
  providers          List configured providers
  gateway            Manage the gateway
  doctor             Check system health and prerequisites
  update-images      Rebuild sandbox container images
  update-base        Rewrite .openlock/Containerfile FROM to current base hash
  update-harness     Resolve harness dist-tags + rewrite pinned npm install versions
  prune-images       Remove stale openlock images (use --legacy for pre-M5)
  refs               Inspect and promote sandbox commits to real branches
  validate           Validate .openlock/ config + policy
  report             Collect diagnostic bundle for bug reports
  complete <shell>   Print shell completion script (bash|zsh|fish)

Common flags:
  --policy PATH      Override .openlock/policy.yaml (sandbox)
  --all / --stale    Batch operations (stop, clean)
  --copy DIR         Extract /sandbox/repo before teardown (clean)
  --json             Machine-readable output (list, status)
  --help, -h         Show this help
  --version, -v      Show version
  --print-base-tag   Print the expected ghcr tag for the embedded base image
`.trim();

function main(): void {
  const args = process.argv.slice(2);

  // Global flags (--version/-v, --print-base-tag, and --help/-h below) are
  // only recognized before the first `--` separator. `exec`/`shell` use `--`
  // to mark "everything after this belongs to the exec'd command inside the
  // sandbox", so a naive `args.includes(...)` scan over the whole argv would
  // hijack e.g. `openlock exec X -- rm -v file` or `-- ssh -v host` — printing
  // openlock's OWN version and exiting 0 without ever running the command
  // (openlock-j9d). Restricting the scan to the pre-`--` prefix preserves
  // --version/--print-base-tag working anywhere in openlock's own invocation
  // (per the "Common flags" usage text) while never looking past a `--` that
  // belongs to someone else.
  const sepIdx = args.indexOf("--");
  const globalArgs = sepIdx === -1 ? args : args.slice(0, sepIdx);

  if (globalArgs.includes("--version") || globalArgs.includes("-v") || args[0] === "version") {
    // OPENLOCK_BUILD_SHA is substituted at compile time via `bun build --define`
    // (see .github/workflows/release.yml). Absent for local `bun run`, where
    // `typeof` on the undeclared identifier safely yields "undefined".
    const buildSha = typeof OPENLOCK_BUILD_SHA === "string" ? OPENLOCK_BUILD_SHA : null;
    console.log(buildSha ? `${pkg.version} (${buildSha})` : pkg.version);
    process.exit(0);
  }

  if (globalArgs.includes("--print-base-tag")) {
    console.log(computeBaseTag(BASE_CONTAINERFILE));
    process.exit(0);
  }

  if (args.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  // If --help/-h appears BEFORE any command, treat as global help.
  // Once a command is present, dispatch and let the command handler
  // print per-command help via `values.help` in its parseArgs result.
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "list":
      import("./cli/list").then(({ listCmd }) => listCmd(args.slice(1)).then(processExit));
      return;
    case "status":
      import("./cli/status").then(({ statusCmd }) => statusCmd(args.slice(1)).then(processExit));
      return;
    case "stop":
      import("./cli/stop").then(({ stopCmd }) => stopCmd(args.slice(1)).then(processExit));
      return;
    case "clean":
      import("./cli/clean").then(({ cleanCmd }) => cleanCmd(args.slice(1)).then(processExit));
      return;
    case "reap":
      import("./cli/reap").then(({ reapCmd }) => reapCmd(args.slice(1)).then(processExit));
      return;
    case "shell":
      import("./cli/shell").then(({ shellCmd }) => shellCmd(args.slice(1)).then(processExit));
      return;
    case "exec":
      import("./cli/exec").then(({ execCmd }) => execCmd(args.slice(1)).then(processExit));
      return;
    case "logs":
      import("./cli/logs").then(({ logsCmd }) => logsCmd(args.slice(1)).then(processExit));
      return;
    case "cred-refresh":
      import("./cli/cred-refresh").then(({ credRefreshCmd }) => credRefreshCmd(args.slice(1)));
      return;
    case "echo-server":
      console.error("echo-server not yet implemented");
      process.exit(1);
      return;
    case "sandbox":
      import("./cli/sandbox").then(({ sandboxCmd }) => sandboxCmd(args.slice(1)));
      return;
    case "logout":
      import("./cli/logout").then(({ logoutCmd }) => logoutCmd(args.slice(1)));
      return;
    case "providers":
      import("./cli/providers").then(({ providersCmd }) => providersCmd(args.slice(1)));
      return;
    case "login":
      import("./login").then(async ({ login }) => {
        const { parseArgs } = await import("node:util");
        const { flagSchema } = await import("./cli/login");
        const { values } = parseArgs({
          args: args.slice(1),
          options: flagSchema,
          allowPositionals: false,
        });
        await login({ providerFlag: values.provider });
      });
      return;
    case "gateway":
      import("./cli/gateway").then(({ gatewayCmd }) => gatewayCmd(args.slice(1)));
      return;
    case "doctor":
      import("./doctor").then(async ({ doctor }) => {
        const { parseArgs } = await import("node:util");
        const { flagSchema } = await import("./cli/doctor");
        const { values } = parseArgs({
          args: args.slice(1),
          options: flagSchema,
          allowPositionals: false,
        });
        if (values.help) {
          console.log(
            "Usage: openlock doctor\n\nCheck system health and prerequisites (container runtime, git, gateway reachability).",
          );
          process.exit(0);
        }
        await doctor();
      });
      return;
    case "update-images":
      import("./cli/update-images").then(({ updateImagesCmd }) => updateImagesCmd(args.slice(1)));
      return;
    case "update-base":
      import("./cli/update-base").then(({ updateBaseCmd }) =>
        updateBaseCmd(args.slice(1)).then(processExit),
      );
      return;
    case "update-harness":
      import("./cli/update-harness").then(({ updateHarnessCmd }) =>
        updateHarnessCmd(args.slice(1)).then(processExit),
      );
      return;
    case "prune-images":
      import("./cli/prune-images").then(({ pruneImagesCmd }) =>
        pruneImagesCmd(args.slice(1)).then(processExit),
      );
      return;
    case "refs":
      import("./cli/refs").then(({ refsCmd }) => refsCmd(args.slice(1)).then(processExit));
      return;
    case "report":
      import("./cli/report").then(({ reportCmd }) => reportCmd(args.slice(1)).then(processExit));
      return;
    case "complete":
      import("./cli/complete").then(({ completeCmd }) =>
        completeCmd(args.slice(1)).then(processExit),
      );
      return;
    case "init":
      import("./cli/init").then(({ initCmd }) => initCmd(args.slice(1)).then(processExit));
      return;
    case "setup":
      import("./cli/setup").then(({ setupCmd }) => setupCmd(args.slice(1)).then(processExit));
      return;
    case "validate":
      import("./cli/validate").then(({ validateCmd }) => validateCmd(args.slice(1)));
      return;
    case "__list-sessions":
      import("./sandbox/session-store").then(({ listAllSessions, sessionsDir }) => {
        for (const m of listAllSessions(sessionsDir())) console.log(m.name);
        process.exit(0);
      });
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

function processExit(code: number): void {
  process.exit(code);
}

// Several command branches dispatch as a bare `import(...).then(cmd)` with no
// `.catch()`, so a throw inside a handler (e.g. `ensureRepoIsGit`, a missing
// provider) would otherwise surface as Bun's raw unhandled-rejection stack
// dump. This net gives them the same friendly one-line error the try/catch
// commands emit, and exits non-zero.
process.on("unhandledRejection", (reason: unknown) => {
  console.error(`openlock: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
});

main();
