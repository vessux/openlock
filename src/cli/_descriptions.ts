// Single source of truth for one-line command descriptions. Consumed by
// per-command --help (printCmdHelp), zsh _values, and fish complete -d.
// USAGE block in cli.ts is an independent multi-column layout and is not
// templated from this map.
//
// This file deliberately has no upward imports so it can be imported from
// _help.ts (which is in turn imported by every command file) without
// creating a cycle through _commands.ts.

export const COMMAND_DESCRIPTIONS = {
  sandbox: "Create or resume a sandbox session",
  list: "List all sessions",
  status: "Show session metadata + container state",
  stop: "Stop session containers (preserves state)",
  clean: "Tear down session (rm container + state + host refs)",
  reap: "Stop idle sessions (no removal)",
  shell: "Open bash inside the session container",
  exec: "Run a command inside the session container",
  logs: "Tail the in-sandbox proxy egress log (L7 allow/deny decisions)",
  "cred-refresh": "Start the credential refresh service",
  login: "Authenticate with the gateway",
  logout: "Remove stored provider credentials",
  providers: "List configured providers",
  gateway: "Manage the gateway",
  doctor: "Check system health and prerequisites",
  "update-images": "Rebuild sandbox container images",
  // openlock-tuxj: these three were real, dispatched commands (see the
  // switch in cli.ts) that never got an entry here or in COMMAND_FLAGS, so
  // completions/--help/description lists silently omitted them. Wording
  // below is verbatim from the USAGE block in cli.ts, except prune-images
  // drops the "(use --legacy for pre-M5)" parenthetical to match every
  // other entry in this map being flag-agnostic.
  "update-base": "Rewrite .openlock/Containerfile FROM to current base hash",
  "update-harness": "Resolve harness dist-tags + rewrite pinned npm install versions",
  "prune-images": "Remove stale openlock images",
  complete: "Print shell completion script",
  refs: "Inspect and promote sandbox commits to real branches",
  report: "Collect diagnostic bundle for bug reports",
  init: "Scaffold .openlock/ for a project (interactive)",
  setup: "Configure machine defaults (runtime, harness, provider)",
  validate: "Validate .openlock/ config + policy",
} as const;

export type CommandName = keyof typeof COMMAND_DESCRIPTIONS;
