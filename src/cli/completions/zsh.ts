import type { ParseArgsOptionsConfig } from "node:util";
import { COMMAND_FLAGS, type CommandName } from "../_commands";
import { flagsOf } from "./_flag-format";

function flagsToZshValues(schema: ParseArgsOptionsConfig): string {
  const infos = flagsOf(schema);
  const tokens: string[] = [];
  for (const info of infos) {
    tokens.push(`'${info.long}'`);
    if (info.short) tokens.push(`'${info.short}'`);
  }
  return tokens.join(" ");
}

function emitCmdCase(cmd: CommandName): string {
  const schema = COMMAND_FLAGS[cmd];
  const flagValues = flagsToZshValues(schema);
  if (cmd === "sandbox") {
    return `    sandbox)
      if [[ "\${words[CURRENT]}" == -* ]]; then
        _values 'flags' ${flagValues}
      else
        _files -/
      fi
      ;;`;
  }
  if (cmd === "gateway") {
    return `    gateway)
      _values 'subcommand' 'start' 'stop' 'status'
      ;;`;
  }
  if (cmd === "refs") {
    return `    refs)
      _values 'subcommand' 'list' 'promote'
      ;;`;
  }
  if (cmd === "complete") {
    return `    complete)
      _values 'shell' 'bash' 'zsh' 'fish'
      ;;`;
  }
  if (cmd === "status" || cmd === "stop" || cmd === "clean" || cmd === "shell" || cmd === "exec") {
    return `    ${cmd})
      if [[ "\${words[CURRENT]}" == -* ]]; then
        _values 'flags' ${flagValues}
      else
        _openlock_sessions
      fi
      ;;`;
  }
  return `    ${cmd})
      _values 'flags' ${flagValues}
      ;;`;
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

export function completionScript(): string {
  const subcommandLines = (Object.keys(COMMAND_FLAGS) as CommandName[])
    .map((cmd) => `    '${cmd}:${COMMAND_DESCRIPTIONS[cmd]}'`)
    .join("\n");
  const cases = (Object.keys(COMMAND_FLAGS) as CommandName[]).map(emitCmdCase).join("\n");
  return `#compdef openlock
# zsh completion for openlock

_openlock_sessions() {
  local -a names
  names=(\${(f)"$(openlock __list-sessions 2>/dev/null)"})
  _describe 'session' names
}

_openlock() {
  local -a subcommands
  subcommands=(
${subcommandLines}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' subcommands
    return
  fi

  case "\${words[2]}" in
${cases}
    *)
      _values 'flags' '--help' '-h'
      ;;
  esac
}

_openlock "$@"
`;
}
