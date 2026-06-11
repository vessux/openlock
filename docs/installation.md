# Installation & shell completion

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/install.sh | bash
```

Drops `openlock` into `~/.local/bin`. Set `OPENLOCK_INSTALL_DIR` to override. The fork binaries (gateway, supervisor, openshell CLI) are fetched lazily on first run into `~/.cache/openlock/bin/`.

## Prerequisites

- [podman](https://podman.io) — `podman machine` started on macOS, or a reachable rootless socket on Linux (`systemctl --user enable --now podman.socket`)
- `git`
- `claude` CLI inside the sandbox is bundled into the container image — no host install needed

Verify with `openlock doctor`.

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
