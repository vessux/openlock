import type { ParseArgsOptionsConfig } from "node:util";
import { COMMAND_FLAGS, type CommandName } from "../_commands";
import { flagsOf } from "./_flag-format";

function flagsToBashList(schema: ParseArgsOptionsConfig): string {
  const infos = flagsOf(schema);
  const tokens: string[] = [];
  for (const info of infos) {
    tokens.push(info.long);
    if (info.short) tokens.push(info.short);
  }
  return tokens.join(" ");
}

function emitCmdCase(cmd: CommandName): string {
  const schema = COMMAND_FLAGS[cmd];
  const flagList = flagsToBashList(schema);
  if (cmd === "sandbox") {
    return `    sandbox)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "${flagList}" -- "$cur") )
      else
        COMPREPLY=( $(compgen -d -- "$cur") )
      fi
      return 0
      ;;`;
  }
  if (cmd === "gateway") {
    return `    gateway)
      COMPREPLY=( $(compgen -W "start stop status" -- "$cur") )
      return 0
      ;;`;
  }
  if (cmd === "complete") {
    return `    complete)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return 0
      ;;`;
  }
  // session-name commands: offer flags when "-" prefix, else session names
  if (cmd === "status" || cmd === "stop" || cmd === "clean" || cmd === "shell" || cmd === "exec") {
    return `    ${cmd})
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "${flagList}" -- "$cur") )
      else
        local names
        names="$(openlock __list-sessions 2>/dev/null)"
        COMPREPLY=( $(compgen -W "$names" -- "$cur") )
      fi
      return 0
      ;;`;
  }
  // generic: just flags
  return `    ${cmd})
      COMPREPLY=( $(compgen -W "${flagList}" -- "$cur") )
      return 0
      ;;`;
}

export function completionScript(): string {
  const cmds = Object.keys(COMMAND_FLAGS) as CommandName[];
  const subcommands = cmds.join(" ");
  const cases = cmds.map(emitCmdCase).join("\n");
  return `# bash completion for openlock
_openlock() {
  local cur cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  local subcommands="${subcommands}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$subcommands --help -h --version -v" -- "$cur") )
    return 0
  fi

  case "$cmd" in
${cases}
  esac
}
complete -F _openlock openlock
`;
}
