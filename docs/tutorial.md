# Tutorial: fix a bug in a sandbox

A walkthrough of the full loop — scaffold, launch, let Claude Code fix something, get the fix back onto a real branch — using a concrete (if generic) scenario: a failing test in your own repo. Swap in whatever bug you actually have; nothing here depends on the specifics.

See [Quickstart](./quickstart.md) first if you haven't installed/logged in yet, and [Recipes](./recipes.md) afterward for mounts, secondary credentials, and egress customization.

## The scenario

Say `my-api`'s test suite has one failing test:

```
FAILED tests/test_orders.py::test_negative_quantity_rejected - AssertionError
```

`create_order()` doesn't validate quantity. You want Claude Code to find and fix it, sandboxed, without giving it your host shell or your real API keys.

## 1. Scaffold and validate

```bash
cd ~/code/my-api
openlock init --harness claude_code
```

Since `.openlock/` is empty and this is a real terminal, `init` asks "Configure how?" — press Enter to accept the default (sensible defaults, no further prompts). This writes `.openlock/config.yaml`, `policy.yaml`, and `Containerfile`, plus a `config.local.yaml.example` for personal overrides later.

```bash
openlock validate
```

Should print `config.yaml: ok · policy.yaml: ok`. Fix anything it flags before continuing — a `.openlock/` that doesn't validate won't build a usable sandbox either.

## 2. Launch

```bash
openlock sandbox --provider anthropic
```

First time: if you have no stored credentials, this launches `openlock login` for you interactively (imports your Claude subscription token). Every time: it builds the sandbox image if missing, starts the gateway, bundles your repo in, and attaches Claude Code inside the container. Because the container — not Claude Code's own permission prompts — is the safety boundary here, it's common (and safe) to pass `--dangerously-skip-permissions` via `args:` in `config.yaml` so Claude Code doesn't stop to ask; see [Recipes](./recipes.md#harness-launch-args) for the exact snippet.

Ask it to fix the failing test the way you'd ask any agent:

> Run `pytest tests/test_orders.py`, find why `test_negative_quantity_rejected` fails, and fix it.

Claude Code reads, edits, runs the test, iterates — all inside the sandbox, against the bundled copy of your repo.

## 3. Ignore the benign denials

While this is running, open a second terminal and tail the in-sandbox egress log:

```bash
openlock logs <session-name>            # last 200 lines
openlock logs <session-name> --follow   # -f: keep streaming
openlock logs <session-name> --lines 500   # -n: change the tail window (default 200)
```

You will see `DENIED` (or similar) entries even on a perfectly healthy session. **These are expected — Claude Code and git make several startup calls the default policy never allowlisted, and denying them is harmless:**

- `POST api.anthropic.com/api/event_logging/v2/batch` — telemetry. Loudest of the bunch; Claude Code retries it repeatedly (observed ~16x) before giving up.
- `GET raw.githubusercontent.com/.../CHANGELOG.md` — Claude Code checking its own changelog.
- `POST api.anthropic.com/api/eval/sdk-*` — internal eval/telemetry endpoint.
- `GET api.anthropic.com/api/claude_code_grove` — another internal endpoint.
- `GET .../oauth/organizations//referral/eligibility` — referral-program check (note the doubled `/`).
- `GET api.anthropic.com/mcp-registry/v0/servers` — MCP registry probe; harmless if you're not using MCP servers.
- `NET:OPEN downloads.claude.ai:443` — Claude Code's self-update check. Denying this is **deliberate**, not a gap: openlock pins an exact Claude Code version per sandbox image for reproducibility, and letting Claude Code silently upgrade itself would undermine that.
- `NET:OPEN github.com:443` (via `git-remote-http`) — only if your repo has no configured remote; git still probes for one.

None of these indicate a broken sandbox. If your actual task fails, look for a denial against a host you *expected* to be reachable instead (a package registry, an internal API your code calls) — that's a real gap in your project's egress allowlist, not a benign one; see [Recipes → Egress allowlist](./recipes.md#egress-allowlist) for how to add it.

## 4. Exit and get the fix back

`/exit` inside Claude Code, or just close the terminal — the container keeps running (`sleep infinity` as its foreground process), so re-running `openlock sandbox` later reattaches instead of starting over.

The sandbox's commits landed on your host under `refs/sandbox/<session>/*`:

```bash
git log refs/sandbox/<session-name>/main
openlock refs list                 # every session's unmerged sandbox commits, with counts
openlock refs promote              # fast-forward/create a real branch from the sandbox work
```

`openlock refs promote [session] [branch]` without arguments picks interactively when there's more than one candidate; pass both to promote non-interactively, or `--force` to overwrite a diverged target, or `-b <name>` to land it under a different branch name than the sandbox's own.

## 5. Clean up (or don't)

```bash
openlock stop <session-name>    # stop the container, keep everything else
openlock clean <session-name>   # tear down container + state + refs entirely
```

Leaving it running is also fine — it's just an idle container until you attach again. `openlock reap` stops idle sessions on demand; set `reap_idle: 30m` (or similar) in `~/.config/openlock/config.yaml` to do that automatically (off by default — see [Recipes](./recipes.md#global-config)).

## One thing this doesn't support yet

Multi-container setups (docker-compose, DinD) aren't supported — each sandbox is a single container.
