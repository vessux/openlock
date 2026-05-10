import type { ParseArgsOptionsConfig } from "node:util";
import { COMMAND_FLAGS, type CommandName } from "../_commands";
import { flagsOf } from "./_flag-format";

function emitFlagsFor(cmd: CommandName, schema: ParseArgsOptionsConfig): string {
  const lines: string[] = [];
  for (const info of flagsOf(schema)) {
    const longName = info.long.slice(2);
    const requiresValue = info.takesValue ? " -r" : "";
    const shortPart = info.short ? ` -s ${info.short.slice(1)}` : "";
    lines.push(
      `complete -c openlock -n "__openlock_using_subcommand ${cmd}" -l ${longName}${shortPart}${requiresValue}`,
    );
  }
  return lines.join("\n");
}

const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  sandbox: "Create or resume a sandbox session",
  list: "List all sessions",
  status: "Show session metadata + container state",
  stop: "Stop session containers",
  clean: "Tear down session",
  reap: "Stop idle sessions",
  shell: "Open bash inside the session container",
  exec: "Run a command inside the session container",
  "cred-refresh": "Start the credential refresh service",
  "validate-policy": "Validate a sandbox policy YAML file",
  login: "Authenticate with the gateway",
  gateway: "Manage the gateway",
  doctor: "Check system health and prerequisites",
  "update-images": "Rebuild sandbox container images",
  complete: "Print shell completion script",
  refs: "Inspect and promote sandbox commits to real branches",
};

const SESSION_CMDS_FOR_FISH = ["status", "stop", "clean", "shell", "exec"] as const;

export function completionScript(): string {
  const cmds = Object.keys(COMMAND_FLAGS) as CommandName[];
  const topLevel = cmds
    .map(
      (c) =>
        `complete -c openlock -n '__openlock_no_subcommand' -f -a ${c} -d '${COMMAND_DESCRIPTIONS[c]}'`,
    )
    .join("\n");
  const flagsBlocks = cmds.map((c) => emitFlagsFor(c, COMMAND_FLAGS[c])).join("\n");
  const sessionNameCompletions = SESSION_CMDS_FOR_FISH.map(
    (c) =>
      `complete -c openlock -n "__openlock_using_subcommand ${c}" -f -a '(__openlock_sessions)'`,
  ).join("\n");
  return `# fish completion for openlock

function __openlock_no_subcommand
  set -l cmd (commandline -opc)
  if test (count $cmd) -lt 2
    return 0
  end
  return 1
end

function __openlock_using_subcommand
  set -l cmd (commandline -opc)
  if test (count $cmd) -lt 2
    return 1
  end
  test "$cmd[2]" = "$argv[1]"
end

function __openlock_sessions
  openlock __list-sessions 2>/dev/null
end

# Top-level subcommands
${topLevel}

# Session-name completions
${sessionNameCompletions}

# sandbox: dir + flags via the per-command flag block below
complete -c openlock -n '__openlock_using_subcommand sandbox' -a '(__fish_complete_directories)'

# gateway subcommands
complete -c openlock -n '__openlock_using_subcommand gateway' -f -a 'start stop status'

# refs subcommands
complete -c openlock -n '__openlock_using_subcommand refs' -f -a 'list promote'

# complete subcommand (shells)
complete -c openlock -n '__openlock_using_subcommand complete' -f -a 'bash zsh fish'

# Per-command flags
${flagsBlocks}
`;
}
