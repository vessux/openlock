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

## Shell completion

`openlock` ships completion scripts for bash, zsh, and fish via a generator subcommand:

```sh
openlock complete <bash|zsh|fish>
```

Completion covers subcommands, common flags, and live session names (queried at Tab time via the hidden `openlock __list-sessions` subcommand — filesystem only, no podman calls).

### zsh (compinit-friendly install)

```sh
mkdir -p ~/.zsh/completions
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
openlock complete zsh > ~/.zsh/completions/_openlock
compinit
```

Or system-wide: `openlock complete zsh > "${fpath[1]}/_openlock"`.

### bash

```sh
echo 'source <(openlock complete bash)' >> ~/.bashrc
```

Or system-wide: `openlock complete bash | sudo tee /etc/bash_completion.d/openlock`.

### fish

```sh
openlock complete fish > ~/.config/fish/completions/openlock.fish
```

## Interactive session picker

Commands that take a session name (`status`, `stop`, `clean`, `shell`, `exec`) accept it as a positional argument. When you omit it, openlock resolves the session as follows:

- **Exactly one session** for your current directory → that one is used silently.
- **Multiple sessions** for your cwd, **or** zero in cwd but sessions exist elsewhere → an interactive picker appears (uses `fzf` if installed; otherwise a numbered prompt).
- **No sessions exist anywhere**, or you're not running interactively → openlock falls back to the existing text error.

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

**Sandbox boundary.** Always reach into a session via `openlock shell` / `openlock exec` — these route through the openshell supervisor, which applies `HTTPS_PROXY`, Landlock, seccomp, and netns enforcement. Direct `podman exec sandbox-<name> ...` from the host bypasses the supervisor and lands the process in the container's netns without proxy enforcement, so egress policy, `cred_inject`, and the per-binary credential gate do not apply. Treat podman socket access as part of your trust boundary.

### Container runtime choice

openlock supports **podman** (default, rootless) and **docker** as container runtimes. Select via:

- `OPENLOCK_RUNTIME=docker|podman` (per-invocation override)
- `default_runtime: docker|podman` in `~/.config/openlock/config.yaml` (persistent)
- The first-run wizard prompts when neither is set and autodetect is ambiguous.

#### Threat model deltas

The sandbox's in-container controls (Landlock, seccomp, namespace isolation, supervisor netns enforcement) are **identical** across runtimes. The differences live at the host trust boundary:

- **Podman, rootless (default on Linux)**: the container is spawned by an unprivileged user. A breakout still lands in your user account, not root.
- **Docker, rootful (default on most installs)**: the Docker daemon runs as root and spawns containers as root. A breakout that escapes the supervisor lands at root unless userns-remap is configured.
- **Rootless Docker** is supported but uncommon. It approximates rootless podman's host posture.
- **Mac (both runtimes)**: containers run inside a VM (Podman Machine or Docker Desktop's LinuxKit VM). The VM is the trust boundary; host exposure requires VM escape.

We recommend **rootless podman** for sensitive work. Docker is supported for compatibility with existing developer setups; use rootless docker or userns-remap if your threat model requires it.

## Policies

Default policies live in `policies/` and are selected by detected capabilities:

- `default.yaml` — base
- `default-js.yaml` — JavaScript projects
- `default-py.yaml` — Python projects
- `default-js-py.yaml` — both

Override with `--policy /abs/path/to/policy.yaml`.

## Seeds: mounts, args, env

`.openlock/config.yaml` accepts three optional fields that let you inject host content into the sandbox and tweak the agent launch:

- `mounts[]` — entries that wire host paths into the container. Each entry requires `source` (host path, absolute / `~/...` / relative-to-project-root), `target` (absolute container path), and `type` (one of `copy-once`, `copy-refresh`, `bind`, `git-bundle`). Optional `readOnly: true` is valid on `bind` only.
- `args[]` — extra argv appended to the in-container agent launch (today: `claude`).
- `env{}` — extra environment variables set on the agent process.

### Mount types

| type | semantics | target |
|---|---|---|
| `copy-once` | stage once at create | under `/sandbox/.openlock/` (not `/sandbox/repo`) |
| `copy-refresh` | re-stage on every attach | under `/sandbox/.openlock/` (not `/sandbox/repo`) |
| `bind` | live `podman -v` passthrough | anywhere; `readOnly: true` supported |
| `git-bundle` | host repo bundled at create, cloned in container | anywhere outside `/sandbox/.openlock/` |

The container path `/sandbox/repo` is the **workdir**: agent launch + sync-back hardcode `-w /sandbox/repo`. The workdir mount is optional; if present, its `type` must be `bind` or `git-bundle`. If absent, openlock provisions an empty `/sandbox/repo` so existing exec helpers don't fail. Reserved names under `/sandbox/.openlock/`: `.gitconfig`, `bundles`.

#### Example — git-bundle workdir (default / typical)

```yaml
caps: [js]
mounts:
  - source: .
    target: /sandbox/repo
    type: git-bundle
```

Host repo is bundled at session create + cloned to `/sandbox/repo`. Commits sync back via `refs/sandbox/<session>/*` on session exit. `--branch <name>` honoured at clone time.

#### Example — bind workdir (live editor sync)

```yaml
mounts:
  - source: .
    target: /sandbox/repo
    type: bind
```

Host directory mounted live. No bundle, no clone, no sync-back — edits propagate both ways immediately.

#### Example — bind host cache for cross-session reuse

```yaml
mounts:
  - source: ~/.cache/uv
    target: /home/sandbox/.cache/uv
    type: bind
```

#### Example — read-only bind for log tailing

```yaml
mounts:
  - source: ./logs
    target: /home/sandbox/logs
    type: bind
    readOnly: true
```

Note: avoid binding under `/sandbox/.openlock/` — that prefix is openlock's `--upload` destination and a bind there collides with the staging upload.

#### Example — no workdir mount (in-container clone / scratch)

```yaml
mounts: []
```

`/sandbox/repo` is provisioned empty + owned by `sandbox:sandbox`. Agent or user populates via `git clone` or any other means.

#### Example — multi-repo git-bundle (workdir + extras)

```yaml
mounts:
  - source: .
    target: /sandbox/repo
    type: git-bundle
  - source: ../shared-lib
    target: /sandbox/shared-lib
    type: git-bundle
```

Each git-bundle source basename must be unique. Sync-back applies to the workdir bundle only; non-workdir bundles are snapshot-at-create.

#### Example — Claude Code with seed-skills plugin (copy-refresh)

```yaml
caps: [js]
mounts:
  - source: ~/.cache/seed-skills/bundles/abc123
    target: /sandbox/.openlock/skills
    type: copy-refresh
args: ["--plugin-dir", "/sandbox/.openlock/skills"]
```

### Notes

**Security (bind).** Bind mounts grant the container live access to host files. Container-side compromise reaches host. You decide the exposure surface.

**Ownership (Linux bind).** On rootless podman, the openshell fork auto-applies `--userns=keep-id:uid=N,gid=N` (sandbox uid from the image's `USER` directive) whenever any `--volume` is set, so bind files are bidirectionally editable across host ↔ container without manual prep. On rootless docker, ownership depends on daemon-wide `userns-remap`; for cross-uid bind on docker, prefer copy-* mounts. On Mac the virtiofs layer handles this transparently.

**Sandbox uid in `openlock-core` images: 999999 (diverges from upstream).** The openshell fork's [`COMMUNITY_SANDBOX_UID`](https://github.com/vessux/OpenShell/blob/main/crates/openshell-driver-podman/src/client.rs) is `1_000_660_000` — high enough to avoid host-uid collisions when no userns remapping is active. The fork uses that value only as a fallback when `Config.User` is non-numeric; the actual uid for the `--userns=keep-id:uid=N` call comes from each image's `USER` directive, parsed as `u32`. **Our `openlock-core` images pin uid `999999` with `USER 999999:999999`** because `1_000_660_000` falls outside macOS podman-machine's default subuid range (`100000-1099999`) and breaks `openlock update-images` on Mac with `crun: setgroups: Invalid argument`. `999999` fits both Mac (1..1_000_000) and Linux (`524288+` typical) ranges. The fork handles per-image uids cleanly, so `openlock-core` (999999), upstream community images (1_000_660_000), and BYOC images with their own uid all coexist — the only caveat is that host-side scripts hardcoding `1_000_660_000` (chown, manual cleanup) will not target `openlock-core` containers. If you ship a BYOC image, declare a numeric `USER <uid>:<gid>` and the fork will pick it up automatically.

**VM driver.** Bind mounts are NOT supported when openshell uses its VM driver. The driver rejects bind mounts at sandbox create.

**Symlinks (copy-*).** Symlinks in `mounts[].source` are dereferenced at copy time, so producers that compile to host-symlinked caches (e.g., seed-skills) materialize as real files inside the container.

**Validation.** Openlock does not cross-validate `target` paths against references in `args[]` / `env{}`.

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

