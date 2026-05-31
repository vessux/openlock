# Sessions: picker & lifecycle

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
openlock clean --stale       # remove exited + missing sessions
openlock clean <name> --copy ./out   # extract /sandbox/repo before teardown

# stop idle-stale sessions (no removal; default 30 min idle, OPENLOCK_REAP_IDLE_MS)
openlock reap

# attach a bash shell to the container
openlock shell [name]

# run a one-off command inside the container
openlock exec [name] -- git status
```

If `[name]` is omitted and exactly one session exists, it is selected. Multiple sessions → run `openlock list` to disambiguate.
