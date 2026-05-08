#!/usr/bin/env bun
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, resolveEndpoint } from "./cred-refresh/config";
import { runRefreshLoop } from "./cred-refresh/loop";
import { formatErrors, validatePolicyFile } from "./validate-policy";

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

Common flags:
  --policy PATH      Override .openlock/policy.yaml (sandbox)
  --keep-gateway     Don't stop gateway when last sandbox exits (sandbox)
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

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
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
      credRefresh(args.slice(1));
      return;
    case "validate-policy":
      validatePolicy(args.slice(1));
      return;
    case "echo-server":
      console.error("echo-server not yet implemented");
      process.exit(1);
      return;
    case "sandbox":
      sandboxCmd(args.slice(1));
      return;
    case "login":
      import("./login").then(({ login }) => login());
      return;
    case "gateway":
      gatewayCmd(args.slice(1));
      return;
    case "doctor":
      doctorCmd(args.slice(1));
      return;
    case "update-images":
      updateImagesCmd(args.slice(1));
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

function credRefresh(args: string[]): void {
  const configIdx = args.indexOf("--config");
  const configIdxShort = args.indexOf("-c");
  const idx = configIdx !== -1 ? configIdx : configIdxShort;
  const configPath =
    idx !== -1 && args[idx + 1] ? args[idx + 1] : join(process.cwd(), "providers", "refresh.yaml");

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    console.error(`[cred-refresh] ${(e as Error).message}`);
    process.exit(1);
  }

  const endpoint = resolveEndpoint(config.endpoint);
  console.log(`[cred-refresh] endpoint: ${endpoint}`);
  console.log(`[cred-refresh] config: ${configPath}`);

  runRefreshLoop(config);
}

function validatePolicy(args: string[]): void {
  const files = args.filter((a) => !a.startsWith("-"));
  if (files.length === 0) {
    console.error("[validate-policy] no files specified");
    console.error("Usage: openlock validate-policy <file.yaml> [file2.yaml ...]");
    process.exit(1);
  }

  let hasErrors = false;
  for (const file of files) {
    const errors = validatePolicyFile(file);
    if (errors.length > 0) {
      hasErrors = true;
      console.error(formatErrors(errors, file));
    } else {
      console.log(`  ${file}: valid`);
    }
  }

  process.exit(hasErrors ? 1 : 0);
}

function sandboxCmd(args: string[]): void {
  const path = args.find((a) => !a.startsWith("-")) ?? process.cwd();
  const policyIdx = args.indexOf("--policy");

  import("./sandbox/session").then(({ runSandbox }) =>
    runSandbox({
      path,
      policy: policyIdx !== -1 ? args[policyIdx + 1] : undefined,
      keepGateway: args.includes("--keep-gateway"),
    }),
  );
}

function gatewayCmd(args: string[]): void {
  const sub = args[0];

  switch (sub) {
    case "start":
      import("./sandbox/ensure-gateway").then(({ startGateway }) => startGateway());
      return;
    case "stop":
      import("./sandbox/ensure-gateway").then(({ stopGateway }) => stopGateway());
      return;
    case "status":
      import("./sandbox/ensure-gateway").then(({ gatewayStatus }) => {
        const status = gatewayStatus();
        console.log(JSON.stringify(status));
      });
      return;
    default:
      console.error("Usage: openlock gateway <start|stop|status>");
      process.exit(1);
  }
}

function doctorCmd(_args: string[]): void {
  import("./doctor").then(({ doctor }) => doctor());
}

function updateImagesCmd(args: string[]): void {
  const noCache = args.includes("--no-cache");
  import("./sandbox/build-images").then(({ updateImages }) =>
    updateImages({ noCache }).catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    }),
  );
}

function processExit(code: number): void {
  process.exit(code);
}

main();
