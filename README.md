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

1. Reads the project's `.openlock/` manifest (config + policy) and selects the image for your configured harness.
2. Builds the supervisor + sandbox images via `podman build` if missing.
3. Starts the gateway — on first run it fetches the prebuilt `openshell-gateway` binary (dev builds compile it from source).
4. Bundles your repo with `git bundle`, uploads it, pre-trusts `/sandbox/repo`.
5. Injects host git identity (`user.name` / `user.email` from `git config --global`).
6. Launches Claude Code inside the sandbox; outbound traffic flows through the gateway with credentials injected from your `openlock login` token.
7. On exit, fetches sandbox commits back into your repo under `refs/sandbox/<session>/*`.
8. Container persists (entrypoint is `sleep infinity`) so you can resume the same session later. Re-running `openlock sandbox <path>` reattaches.
9. Stops the gateway when no other `openshell-sandbox-*` containers remain.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/install.sh | bash
```

Drops `openlock` into `~/.local/bin`. Set `OPENLOCK_INSTALL_DIR` to override. The fork binaries (gateway, supervisor, openshell CLI) are fetched lazily on first run into `~/.cache/openlock/bin/`.

To remove openlock, run `curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/uninstall.sh | bash` — by default it's conservative: it stops the gateway and reports what remains, keeping the binary if sandboxes still need it to be cleaned up. `--purge` removes everything including sandboxes and workspace volumes, with a confirmation prompt if any uncommitted work could be at risk. See [docs/installation.md](docs/installation.md#uninstall) for details.

## Prerequisites

- [podman](https://podman.io) — `podman machine` started on macOS, or a reachable rootless socket on Linux (`systemctl --user enable --now podman.socket`)
- `git`
- `claude` CLI inside the sandbox is bundled into the container image — no host install needed

Verify with `openlock doctor`.

## Quick start

The golden path is **install → doctor → init → validate → sandbox**:

```bash
# Linux only: enable the podman API socket once
systemctl --user enable --now podman.socket

openlock doctor                       # check prerequisites, get actionable fixes
openlock init /path/to/your/repo      # scaffold .openlock/ (interactive)
openlock validate /path/to/your/repo  # lint the manifest + policy
openlock sandbox /path/to/your/repo   # launch (path defaults to cwd)
```

`sandbox` requires an `.openlock/` (run `openlock init` first, or it errors). If you have no
credentials it runs `openlock login` (the Anthropic provider imports your Claude subscription
token from an isolated `claude auth login`). The first run also `git init`s the path if it
isn't a git repo yet, and (re)attaches the session.

## Usage

```bash
# launch (or resume) a sandbox for a project
openlock sandbox /path/to/your/repo

# rebuild sandbox images
openlock update-images

# manage the gateway directly (start keeps it running across cleanups)
openlock gateway start|stop|status
```

After the session exits, sandbox commits are in your repo under `refs/sandbox/<session>/*`. Inspect with `git log refs/sandbox/<session>/main` and merge or cherry-pick as needed.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | Check system health and prerequisites |
| `setup` | Configure machine defaults (runtime, harness, provider) |
| `login` | Authenticate with the gateway |
| `logout` | Remove stored provider credentials |
| `providers [models <id>]` | List configured providers, or check which OpenRouter models a stored key is allowed to use |
| `init [path]` | Scaffold .openlock/ for a project (interactive) |
| `validate [path]` | Validate .openlock/ config + policy |
| `sandbox [path]` | Create or resume a sandbox session |
| `list` | List all sessions |
| `status [name]` | Show session metadata + container state |
| `stop [name]` | Stop session containers (preserves state) |
| `clean [name]` | Tear down session (rm container + state + host refs) |
| `reap` | Stop idle sessions (no removal) |
| `shell [name]` | Open bash inside the session container |
| `exec [name] -- <cmd>` | Run a command inside the session container |
| `refs` | Inspect and promote sandbox commits to real branches |
| `report` | Collect diagnostic bundle for bug reports |
| `gateway start\|stop\|status` | Manage the gateway |
| `update-images [--no-cache]` | Rebuild sandbox container images |
| `update-base` | Rewrite .openlock/Containerfile FROM to current base hash |
| `update-harness` | Resolve harness dist-tags + rewrite pinned npm install versions |
| `prune-images [--legacy] [--dry-run]` | Remove stale openlock images |
| `complete <bash\|zsh\|fish>` | Print shell completion script |
| `cred-refresh` | Start the credential refresh service |

> **Sandbox boundary.** Always reach into a session via `openlock shell` / `openlock exec` — never `podman exec` directly, which bypasses the supervisor (egress policy, `cred_inject`, and the per-binary credential gate stop applying). See [Security & runtime](./docs/security.md).

## Documentation

- [Quickstart](./docs/quickstart.md) — the golden path, end to end
- [Tutorial: fix a bug in a sandbox](./docs/tutorial.md) — a full session walkthrough
- [Recipes](./docs/recipes.md) — copy-paste config snippets + a custom Containerfile walkthrough
- [Installation & shell completion](./docs/installation.md)
- [Sessions: picker & lifecycle](./docs/sessions.md)
- [Mounts, args & env](./docs/mounts.md)
- [Policies](./docs/policies.md)
- [Security & runtime](./docs/security.md)
- [Agent config reference](./docs/agent-config-reference.md) — for AI agents configuring openlock

## Repo layout

```
containers/           base.Containerfile — the one shared base image
policies/             YAML egress + trust policies
providers/            Credential refresh config
src/cli.ts            Entry point
src/sandbox/          Sandbox orchestration
src/cred-refresh/     Credential refresh service
src/config-core/policy/  Policy linter
```

Per-harness installs (Claude Code / opencode / pi) aren't in `containers/` — they happen in each project's own `.openlock/Containerfile`, in the block after the `# ---- Harness ----` sentinel (see [Recipes](./docs/recipes.md) for a worked example of extending it).

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
