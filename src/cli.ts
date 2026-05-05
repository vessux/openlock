#!/usr/bin/env bun
import { loadConfig, resolveEndpoint } from "./cred-refresh/config";
import { runRefreshLoop } from "./cred-refresh/loop";
import { validatePolicyFile, formatErrors } from "./validate-policy";
import { join } from "path";

const USAGE = `
openlock - sandbox orchestration toolkit

Usage: openlock <command>

Commands:
  cred-refresh       Start the credential refresh service
  validate-policy    Validate a sandbox policy YAML file
  echo-server        Start the HTTPS echo server for wire proof testing
  sandbox            Manage sandboxes
  login              Authenticate with the gateway
  gateway            Manage the gateway
  doctor             Check system health and prerequisites
  update-images      Rebuild sandbox container images (core + language layers)

Options:
  --config, -c    Config file path (default: providers/refresh.yaml)
  --help, -h      Show this help
`.trim();

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "cred-refresh":
      return credRefresh(args.slice(1));
    case "validate-policy":
      return validatePolicy(args.slice(1));
    case "echo-server":
      console.error("echo-server not yet implemented");
      process.exit(1);
      return;
    case "sandbox":
      return sandboxCmd(args.slice(1));
    case "login":
      import("./login").then(({ login }) => login());
      return;
    case "gateway":
      return gatewayCmd(args.slice(1));
    case "doctor":
      doctorCmd(args.slice(1));
      return;
    case "update-images":
      return updateImagesCmd(args.slice(1));
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
  const configPath = idx !== -1 && args[idx + 1]
    ? args[idx + 1]
    : join(process.cwd(), "providers", "refresh.yaml");

  let config;
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
  const path = args.find((a) => !a.startsWith("-"));
  if (!path) {
    console.error("Usage: openlock sandbox <path> [--name NAME] [--policy PATH] [--keep-gateway]");
    process.exit(1);
  }

  const nameIdx = args.indexOf("--name");
  const policyIdx = args.indexOf("--policy");

  import("./sandbox/session").then(({ runSandbox }) =>
    runSandbox({
      path,
      name: nameIdx !== -1 ? args[nameIdx + 1] : undefined,
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

main();
