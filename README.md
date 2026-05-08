# openlock

Sandbox orchestration for Claude Code. Launches an interactive Claude Code session inside a Podman container, with a credential gateway that strips and re-injects API keys outbound, scopes secrets per binary, and applies a YAML policy that controls egress and package trust.

Status: experimental. macOS (Apple Silicon) and Linux.

## How it works

```
macOS host                              Linux host
├── openlock CLI (Bun)                  ├── openlock CLI (Bun)
├── openshell-gateway (port 18081)      ├── openshell-gateway (port 18081)
└── Podman Machine (Apple HV)           └── podman (rootless)
    └── sandbox container                   └── sandbox container
```

Each `openlock sandbox <path>` call:

1. Detects capabilities (js / py) from the project, picks an image and policy.
2. Builds the supervisor + sandbox images via `podman build` if missing.
3. Starts the gateway (`cargo build` first run, ~1–2 min).
4. Bundles your repo with `git bundle`, uploads it, pre-trusts `/sandbox/repo`.
5. Injects host git identity (`user.name` / `user.email` from `git config --global`).
6. Launches Claude Code inside the sandbox; outbound traffic flows through the gateway with credentials injected from your `openlock login` token.
7. On exit, fetches sandbox commits back into your repo under `refs/sandbox/<session>/*`.
8. Container persists (entrypoint is `sleep infinity`) so you can resume the same session later. Re-running `openlock sandbox <path>` reattaches.
9. Stops the gateway when no other `openshell-sandbox-*` containers remain.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/install.sh | sh
```

Drops `openlock` into `~/.local/bin`. Set `OPENLOCK_INSTALL_DIR` to override. The fork binaries (gateway, supervisor, openshell CLI) are fetched lazily on first run into `~/.cache/openlock/bin/`.

## Prerequisites

- [podman](https://podman.io) — `podman machine` started on macOS, or a reachable rootless socket on Linux (`systemctl --user enable --now podman.socket`)
- `git`
- `claude` CLI inside the sandbox is bundled into the container image — no host install needed

Verify with `openlock doctor`.

## Quick start

```bash
# Linux only: enable the podman API socket once
systemctl --user enable --now podman.socket

openlock sandbox /path/to/your/repo   # path defaults to cwd
```

The first run prompts for `claude setup-token` if you don't already have credentials,
runs `git init` for you if the path isn't a git repo yet, and creates `.openlock/`
with a policy + capability file you can review and commit.

## Usage

```bash
# launch (or resume) a sandbox for a project
openlock sandbox /path/to/your/repo

# keep the gateway running across cleanups
openlock gateway start

# rebuild sandbox images
openlock update-images

# manage gateway directly
openlock gateway start|stop|status
```

After the session exits, sandbox commits are in your repo under `refs/sandbox/<session>/*`. Inspect with `git log refs/sandbox/<session>/main` and merge or cherry-pick as needed.

## Session lifecycle

A session = one persistent container per repo. Exiting Claude (`/exit`) does not destroy the container; the next `openlock sandbox <path>` reattaches. Sessions live under `~/.local/state/openlock/sessions/<id>/`.

```bash
# list every session, with state (running / exited / stale)
openlock list

# inspect a single session (metadata + container state, --json available)
openlock status [name]

# stop the container but keep state and refs
openlock stop [name]
openlock stop --all          # all sessions (skips ones currently attached)

# fully tear down: rm container + state + host refs
openlock clean [name]
openlock clean --all
openlock clean --stale       # only idle-stale (default 30 min, OPENLOCK_REAP_IDLE_MS)
openlock clean <name> --copy ./out   # extract /sandbox/repo before teardown

# stop idle sessions (no removal)
openlock reap

# attach a bash shell to the container
openlock shell [name]

# run a one-off command inside the container
openlock exec [name] -- git status
```

If `[name]` is omitted and exactly one session exists, it is selected. Multiple sessions → run `openlock list` to disambiguate.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | Check prerequisites |
| `login` | Store a Claude Code setup token |
| `sandbox [path]` | Create or resume a Claude Code session for a repo (path defaults to cwd; runs preflight, auto-inits the repo, prompts for login if needed) |
| `list` | List all sessions |
| `status [name]` | Session metadata + container state (`--json`) |
| `stop [name]` | Stop the container (preserves state, refs) |
| `clean [name]` | Tear down container + state + host refs |
| `reap` | Stop idle-stale sessions (no removal) |
| `shell [name]` | Open `bash` inside the session container |
| `exec [name] -- <cmd>` | Run a command inside the session container |
| `gateway start\|stop\|status` | Manage the credential gateway |
| `update-images [--no-cache]` | Rebuild the four sandbox images |
| `validate-policy <file.yaml>` | Lint a sandbox policy |
| `cred-refresh` | Run the credential refresh service |

## Policies

Default policies live in `policies/` and are selected by detected capabilities:

- `default.yaml` — base
- `default-js.yaml` — JavaScript projects
- `default-py.yaml` — Python projects
- `default-js-py.yaml` — both

Override with `--policy /abs/path/to/policy.yaml`.

## Repo layout

```
containers/           Containerfiles for the four sandbox images
policies/             YAML egress + trust policies
providers/            Credential refresh config
src/cli.ts            Entry point
src/sandbox/          Sandbox orchestration
src/cred-refresh/     Credential refresh service
src/validate-policy/  Policy linter
```

## Development

For working on openlock itself, clone the [openshell-fork](https://github.com/vessux/OpenShell) sibling at `./openshell-fork` and run from source:

```bash
git clone -b main https://github.com/vessux/OpenShell.git openshell-fork
bun install
bun run src/cli.ts <subcommand>
```

When `./openshell-fork/.git` exists, openlock auto-detects dev mode and builds the gateway / supervisor / `openshell` CLI from source instead of fetching the pinned release. Dev mode also requires `bun`, `cargo`, and on macOS `cargo-zigbuild`.

## License

Apache-2.0. See [LICENSE](./LICENSE).

