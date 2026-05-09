#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };

const USAGE = `
openlock - sandbox orchestration toolkit

Usage: openlock <command>

Session lifecycle:
  sandbox [path]     Create or resume a sandbox session (path defaults to cwd; runs preflight + auto-inits the repo)
  list               List all sessions
  status [name]      Show session metadata + container state
  stop [name]        Stop session containers (preserves state)
  clean [name]       Tear down session (rm container + state + host refs)
  reap               Stop idle sessions (no removal)
  shell [name]       Open bash inside the session container
  exec [name] -- ... Run a command inside the session container

Other:
  cred-refresh       Start the credential refresh service
  validate-policy    Validate a sandbox policy YAML file
  login              Authenticate with the gateway
  gateway            Manage the gateway
  doctor             Check system health and prerequisites
  update-images      Rebuild sandbox container images
  complete <shell>   Print shell completion script (bash|zsh|fish)

Common flags:
  --policy PATH      Override .openlock/policy.yaml (sandbox)
  --all / --stale    Batch operations (stop, clean)
  --copy DIR         Extract /sandbox/repo before teardown (clean)
  --json             Machine-readable output (list, status)
  --help, -h         Show this help
  --version, -v      Show version
`.trim();

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v") || args[0] === "version") {
    console.log(pkg.version);
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
    case "cred-refresh":
      import("./cli/cred-refresh").then(({ credRefreshCmd }) => credRefreshCmd(args.slice(1)));
      return;
    case "validate-policy":
      import("./cli/validate-policy").then(({ validatePolicyCmd }) =>
        validatePolicyCmd(args.slice(1)),
      );
      return;
    case "echo-server":
      console.error("echo-server not yet implemented");
      process.exit(1);
      return;
    case "sandbox":
      import("./cli/sandbox").then(({ sandboxCmd }) => sandboxCmd(args.slice(1)));
      return;
    case "login":
      import("./login").then(({ login }) => login());
      return;
    case "gateway":
      import("./cli/gateway").then(({ gatewayCmd }) => gatewayCmd(args.slice(1)));
      return;
    case "doctor":
      import("./doctor").then(({ doctor }) => doctor());
      return;
    case "update-images":
      import("./cli/update-images").then(({ updateImagesCmd }) => updateImagesCmd(args.slice(1)));
      return;
    case "complete":
      import("./cli/complete").then(({ completeCmd }) =>
        completeCmd(args.slice(1)).then(processExit),
      );
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

main();
