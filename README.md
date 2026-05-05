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
7. On exit, fetches the sandbox HEAD back into your repo as `remotes/sandbox/main`.
8. Stops the gateway when no other `openshell-sandbox-*` containers remain.

## Prerequisites

Common:
- [bun](https://bun.sh)
- [podman](https://podman.io)
- [cargo](https://rustup.rs)
- `git`
- `claude` CLI ([Claude Code](https://docs.claude.com/en/docs/claude-code))
- An [openshell-fork](https://github.com/vessux/OpenShell) checkout on `feat/cred-inject` placed at `./openshell-fork` (sibling of `src/`)

macOS only:
- `podman machine` (`podman machine init && podman machine start`)
- `cargo-zigbuild` (`cargo install cargo-zigbuild`) for cross-compiling the supervisor to Linux

Linux only:
- The Podman API socket enabled: `systemctl --user enable --now podman.socket` (rootless) or rootful equivalent. The gateway connects via this socket; `podman info` works without it but the gateway will not start.

Verify with `openlock doctor`.

## Setup

```bash
git clone <this-repo> openlock
cd openlock
git clone -b feat/cred-inject https://github.com/vessux/OpenShell.git openshell-fork
bun install

# macOS
podman machine start

# Linux
systemctl --user enable --now podman.socket

bun run src/cli.ts doctor
bun run src/cli.ts login   # paste a Claude Code setup token
```

## Usage

```bash
# launch a sandbox for a project
bun run src/cli.ts sandbox /path/to/your/repo

# keep the gateway running across cleanups
bun run src/cli.ts sandbox /path/to/your/repo --keep-gateway

# rebuild sandbox images
bun run src/cli.ts update-images

# manage gateway directly
bun run src/cli.ts gateway start|stop|status
```

After the session exits, the sandbox's HEAD is in your repo at `remotes/sandbox/main`. Inspect with `git log remotes/sandbox/main` and merge or cherry-pick as needed.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | Check prerequisites |
| `login` | Store a Claude Code setup token |
| `sandbox <path>` | Launch an interactive Claude Code sandbox for a repo |
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
containers/        Containerfiles for the four sandbox images
policies/          YAML egress + trust policies
providers/         Credential refresh config
src/cli.ts         Entry point
src/sandbox/       Sandbox orchestration
src/cred-refresh/  Credential refresh service
src/validate-policy/  Policy linter
openshell-fork/    Vendored OpenShell checkout (not tracked)
```

## License

Apache-2.0. See [LICENSE](./LICENSE).

