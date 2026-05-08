export function completionScript(): string {
  return `# bash completion for openlock
_openlock() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  local subcommands="sandbox list status stop clean reap shell exec cred-refresh validate-policy login gateway doctor update-images complete"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$subcommands --help --version" -- "$cur") )
    return 0
  fi

  case "$cmd" in
    status|stop|clean|shell|exec)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--all --stale --copy --json --help" -- "$cur") )
      else
        local names
        names="$(openlock __list-sessions 2>/dev/null)"
        COMPREPLY=( $(compgen -W "$names" -- "$cur") )
      fi
      return 0
      ;;
    sandbox)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--policy --help" -- "$cur") )
      else
        COMPREPLY=( $(compgen -d -- "$cur") )
      fi
      return 0
      ;;
    gateway)
      COMPREPLY=( $(compgen -W "start stop status" -- "$cur") )
      return 0
      ;;
    complete)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return 0
      ;;
    list|reap|login|doctor|update-images|cred-refresh|validate-policy)
      COMPREPLY=( $(compgen -W "--json --help" -- "$cur") )
      return 0
      ;;
  esac
}
complete -F _openlock openlock
`;
}
