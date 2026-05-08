export function completionScript(): string {
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
complete -c openlock -n '__openlock_no_subcommand' -f -a sandbox -d 'Create or resume a sandbox session'
complete -c openlock -n '__openlock_no_subcommand' -f -a list -d 'List all sessions'
complete -c openlock -n '__openlock_no_subcommand' -f -a status -d 'Show session metadata + container state'
complete -c openlock -n '__openlock_no_subcommand' -f -a stop -d 'Stop session containers'
complete -c openlock -n '__openlock_no_subcommand' -f -a clean -d 'Tear down session'
complete -c openlock -n '__openlock_no_subcommand' -f -a reap -d 'Stop idle sessions'
complete -c openlock -n '__openlock_no_subcommand' -f -a shell -d 'Open bash inside the session container'
complete -c openlock -n '__openlock_no_subcommand' -f -a exec -d 'Run a command inside the session container'
complete -c openlock -n '__openlock_no_subcommand' -f -a cred-refresh -d 'Start the credential refresh service'
complete -c openlock -n '__openlock_no_subcommand' -f -a validate-policy -d 'Validate a sandbox policy YAML file'
complete -c openlock -n '__openlock_no_subcommand' -f -a login -d 'Authenticate with the gateway'
complete -c openlock -n '__openlock_no_subcommand' -f -a gateway -d 'Manage the gateway'
complete -c openlock -n '__openlock_no_subcommand' -f -a doctor -d 'Check system health and prerequisites'
complete -c openlock -n '__openlock_no_subcommand' -f -a update-images -d 'Rebuild sandbox container images'
complete -c openlock -n '__openlock_no_subcommand' -f -a complete -d 'Print shell completion script'

# Session-name commands
for sub in status stop clean shell exec
  complete -c openlock -n "__openlock_using_subcommand $sub" -f -a '(__openlock_sessions)'
  complete -c openlock -n "__openlock_using_subcommand $sub" -l all -d 'All sessions'
  complete -c openlock -n "__openlock_using_subcommand $sub" -l stale -d 'Stale sessions only'
  complete -c openlock -n "__openlock_using_subcommand $sub" -l copy -d 'Copy out repo dir'
  complete -c openlock -n "__openlock_using_subcommand $sub" -l json -d 'JSON output'
end

# sandbox: dir + --policy
complete -c openlock -n '__openlock_using_subcommand sandbox' -a '(__fish_complete_directories)'
complete -c openlock -n '__openlock_using_subcommand sandbox' -l policy -d 'Override policy.yaml' -r

# gateway subcommands
complete -c openlock -n '__openlock_using_subcommand gateway' -f -a 'start stop status'

# complete subcommand
complete -c openlock -n '__openlock_using_subcommand complete' -f -a 'bash zsh fish'
`;
}
