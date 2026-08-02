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

## Clean reinstall

Reinstalling the binary alone does **not** give you a clean slate. openlock's
durable state lives outside the binary, and the piece that matters most is the
gateway database at `~/.local/state/openlock/gateway.db` — it holds the
credential rows that actually get injected into your sandboxes. A default
`uninstall.sh` keeps that file on purpose (it can hold credentials), so an
uninstall/reinstall cycle inherits the old provider rows. If you are
reinstalling *because* authentication is misbehaving, that is exactly the state
you need to clear, and only `--purge` clears it.

Back up anything unrecoverable first. An expired Anthropic subscription token
is fine to discard — `openlock login` mints a new one — but an API key you
pasted in (for example an OpenRouter key, or any `credentials:` bundle value)
exists only in this file:

```bash
cp ~/.config/openlock/credentials.json ~/openlock-credentials.bak.json
```

Then tear down in this order. The gateway is stopped **first and explicitly**,
because it is a host process holding port 18081 that outlives the state
directory it was started from:

```bash
openlock gateway stop
curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/uninstall.sh | bash -s -- --purge
curl -fsSL https://raw.githubusercontent.com/vessux/openlock/main/install.sh | bash
openlock doctor
openlock login
```

Run `--purge` with `--dry-run` first if you want to see the plan. Note that
`uninstall.sh` tears down *through* `openlock`, so it must be able to find and
run the binary; if it prints `openlock binary missing or not runnable`, it has
fallen back to deleting directories and has **not** removed sandbox containers,
workspace volumes, or the gateway process. That happens when openlock is on
your `PATH` somewhere other than `~/.local/bin` (a `bun link` development
install, for instance) — set `OPENLOCK_INSTALL_DIR` to the directory actually
containing the binary, or clean up with `openlock clean --all` and
`openlock gateway stop` by hand before purging.

Container images, containers, and volumes belong to podman rather than to
openlock, and a purge does not reclaim them. To check what is left:

```bash
podman ps -a --filter name=openshell-
podman volume ls
podman system df
```

A full `podman machine rm` / `podman machine init` is only necessary when you
suspect the VM itself, and it forces every base layer to download again.

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
