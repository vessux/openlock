# Installation & shell completion

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/install.sh | bash
```

Drops `openlock` into `~/.local/bin`. Set `OPENLOCK_INSTALL_DIR` to override. The fork binaries (gateway, supervisor, openshell CLI) are fetched lazily on first run into `~/.cache/openlock/bin/`.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/uninstall.sh | bash
```

`install.sh` only drops a binary, but openlock lazily creates gateway state, sandbox containers, workspace volumes, and images that only `openlock` itself knows how to enumerate — so removal isn't just deleting the binary. `uninstall.sh` handles this by tearing down *through* `openlock` while it still exists, then removing the binary.

By default it's conservative: stops the gateway, then **reports** everything else still on disk (sessions, config, credentials, images) with the exact command to remove each — nothing that could hold a credential or uncommitted work is touched unasked.

The binary is removed last, and is deliberately **kept** when sessions or leftover images still need it — otherwise the report would be telling you to run `openlock clean --all` for resources it had just removed the tool for. Its `~/.cache/openlock` is kept alongside it, since that cache holds the fork binaries the CLI needs. The script says so explicitly, so a retained binary doesn't look like a failed uninstall; once nothing needs it, a re-run removes the binary and cache and reports a clean removal.

Pass `--purge` to remove everything, including config, credentials, sandbox containers, and **workspace volumes**. Since a workspace volume can hold uncommitted work, `--purge` warns and asks for an explicit `[y/N]` confirmation whenever sessions still exist (mentioning `openlock clean --all --copy <dir>` as the salvage route); `--yes` skips the prompt for scripted use, and `--dry-run` prints the plan without changing anything.

## Prerequisites

- [podman](https://podman.io) — `podman machine` started on macOS, or a reachable rootless socket on Linux (`systemctl --user enable --now podman.socket`)
- `git`
- `claude` CLI inside the sandbox is bundled into the container image — no host install needed

Verify with `openlock doctor`.

## Rootless podman on Linux

Rootless podman needs the invoking user to have a `subuid`/`subgid` range
configured before it can remap container UIDs. Some distros provision this
automatically at `useradd` time; others (Arch notably) don't, and a fresh
install fails until you add one yourself:

```bash
sudo usermod --add-subuids 100000-1100000 --add-subgids 100000-1100000 $USER
podman system migrate
```

The exact defaults, package, and setup steps vary by distro — see the [Arch
wiki's Rootless Podman page](https://wiki.archlinux.org/title/Podman#Rootless_Podman)
for a worked example; other distros follow the same shape with their own
package manager / default ranges.

**The range has to cover openlock's sandbox uid, not just exist.** openlock's
in-container agent user is a fixed uid (`SANDBOX_UID` in
[`seed-containerfile.ts`](../src/sandbox/seed-containerfile.ts)) that podman's
`--userns=keep-id` remaps through your subuid/subgid range — the range's
*count* has to exceed it, which a commonly-recommended stock range doesn't
always do out of the box. `openlock doctor` checks this on Linux and prints
the exact `usermod --add-subuids ...` command to fix it if your range is too
small, so run it first rather than guessing.

**Footgun: widening a range that's already in use.** If you already have
rootless podman working and need to *widen* your existing subuid/subgid range
(rather than set one up from scratch), stop the podman service for that user
first — a live rootless session keeps using the old mapping until it's
restarted, so `usermod --add-subuids` followed by `podman system migrate`
alone can silently not take effect:

```bash
systemctl --user stop podman.socket
sudo usermod --add-subuids 100000-1100000 --add-subgids 100000-1100000 $USER
podman system migrate
systemctl --user enable --now podman.socket
```

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
