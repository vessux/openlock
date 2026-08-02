# Quickstart

The golden path, end to end, for a first-time run. See [Installation](./installation.md) if `openlock` isn't installed yet.

## Prerequisites

- [podman](https://podman.io) — `podman machine` started on macOS, or a reachable rootless socket on Linux (`systemctl --user enable --now podman.socket`)
- `git`

Verify both with `openlock doctor` before continuing — it prints actionable fixes rather than a bare failure.

## Provider and harness are paired, not a free choice

Pick the harness first; it determines which provider you can use. This is not documented anywhere as a table today, so read it before anything else:

| Harness | Package | Provider | Why |
|---|---|---|---|
| `claude_code` | `@anthropic-ai/claude-code` | `anthropic` only | The Anthropic subscription flow flips Claude Code into OAuth mode via a staged credential file; no other harness has that mechanism. |
| `opencode` | `opencode-ai` | `openrouter` only | opencode reads `OPENROUTER_API_KEY`. |
| `pi` | `@earendil-works/pi-coding-agent` | `openrouter` only | Same OpenRouter env var; pi has no Anthropic-subscription route. |

There is no route to use an Anthropic subscription with `opencode` or `pi` — trying it errors immediately (`Provider 'anthropic' is not compatible with harness 'opencode'. Compatible harnesses: claude_code.`). If you want Claude models through `opencode` or `pi`, that means OpenRouter, not the Anthropic provider.

## The golden path

```bash
openlock doctor                        # check prerequisites, get actionable fixes

cd /path/to/your/repo
openlock init --harness claude_code    # scaffold .openlock/ (prompts once interactively; see below)
openlock validate                      # lint the manifest + policy
openlock login --provider anthropic    # first time only — see "Credentials" below
openlock sandbox --provider anthropic  # launch (or resume) the sandbox
```

Swap `claude_code` / `anthropic` for `opencode` / `openrouter` or `pi` / `openrouter` throughout if you're using one of those harnesses.

**Why `--provider` is on the `sandbox` line, not just at `init`.** `.openlock/config.yaml` persists `harness:`, but there is no `provider:` key in the manifest — provider selection is explicit-only and separate from harness, every time. `openlock sandbox` resolves it from (in order) `--provider`, `OPENLOCK_PROVIDER`, then `default_provider:` in `~/.config/openlock/config.yaml`; if none of those is set it errors rather than guessing. `openlock setup` (interactive, not on this golden path) can persist a `default_provider` so you stop needing the flag — see [Recipes](./recipes.md#global-config).

## What each step actually does

- **`openlock init [path]`** only prompts interactively when the terminal is a TTY *and* `.openlock/` is completely empty — that's the one keypress above (Enter accepts "Write sensible defaults"). If `.openlock/` already has some files, it gap-fills the missing ones without prompting; `--force` regenerates all three files (`config.yaml`, `policy.yaml`, `Containerfile`) unconditionally, non-interactively, **discarding any hand edits** — useful for a fully scripted first run (`openlock init --harness pi --force`), dangerous on a repo you've already customized. There is no `--yes`/`--non-interactive` flag, so a scripted `init` should always pass `--harness` explicitly.
- **`openlock validate [path]`** lints `config.yaml` + `policy.yaml` (and `config.local.yaml` if present) and exits non-zero on any error. Safe to run anytime, offline (`--offline` skips filesystem checks like verifying mount sources exist).
- **`openlock sandbox [path]`** requires `.openlock/` to already exist (run `init` first, or it errors telling you so). If it's the first run and no credentials are stored anywhere, preflight runs `openlock login` for you automatically — but only when the terminal is a TTY; a non-interactive invocation with no credentials errors instead. It also `git init`s the path automatically if it isn't a git repo yet (with an empty first commit, so tooling that needs a HEAD doesn't choke). Re-running `openlock sandbox` on the same path reattaches the existing session instead of creating a new one.

## Credentials

- `openlock login --provider anthropic` imports your Claude subscription token from an isolated `claude auth login` — it never touches your real `~/.claude` config.
- `openlock login --provider openrouter` prompts you to paste an OpenRouter API key (starts with `sk-or-`).
- `openlock providers` shows what's stored and whether the gateway currently has a live copy.
- For `opencode`/`pi`, check which models your specific key is actually allowed to use before picking one in `args:` — see `openlock providers models <id>` in [Recipes](./recipes.md#picking-a-model-your-key-is-allowed-to-use).

## Next steps

- [Tutorial: fix a bug in a sandbox](./tutorial.md) — a full session walkthrough, including what to ignore in `openlock logs`.
- [Recipes](./recipes.md) — copy-paste `config.yaml`/`policy.yaml` snippets: mounts, secondary credentials, CPU/memory limits, harness pins, egress allowlists, a custom `.openlock/Containerfile`.
- [Agent config reference](./agent-config-reference.md) — the complete schema.
