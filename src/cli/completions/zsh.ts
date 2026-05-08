export function completionScript(): string {
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
    'sandbox:Create or resume a sandbox session'
    'list:List all sessions'
    'status:Show session metadata + container state'
    'stop:Stop session containers'
    'clean:Tear down session'
    'reap:Stop idle sessions'
    'shell:Open bash inside the session container'
    'exec:Run a command inside the session container'
    'cred-refresh:Start the credential refresh service'
    'validate-policy:Validate a sandbox policy YAML file'
    'login:Authenticate with the gateway'
    'gateway:Manage the gateway'
    'doctor:Check system health and prerequisites'
    'update-images:Rebuild sandbox container images'
    'complete:Print shell completion script'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' subcommands
    return
  fi

  case "\${words[2]}" in
    status|stop|clean|shell|exec)
      if [[ "\${words[CURRENT]}" == -* ]]; then
        _values 'flags' '--all' '--stale' '--copy' '--json' '--help'
      else
        _openlock_sessions
      fi
      ;;
    sandbox)
      if [[ "\${words[CURRENT]}" == -* ]]; then
        _values 'flags' '--policy' '--help'
      else
        _files -/
      fi
      ;;
    gateway)
      _values 'subcommand' 'start' 'stop' 'status'
      ;;
    complete)
      _values 'shell' 'bash' 'zsh' 'fish'
      ;;
    *)
      _values 'flags' '--json' '--help'
      ;;
  esac
}

_openlock "$@"
`;
}
