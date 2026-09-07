# Agent & contributor instructions

This file, `AGENTS.md`, is **tracked** — it ships in every clone, so change it via a normal
branch + PR. A machine-local `CLAUDE.md` may sit alongside it for a given contributor's own
session habits; that file is git-excluded (see `.git/info/exclude`), never appears in a diff,
and is edited in place, not through a PR.

## Quality gate

Before calling anything done:

```
bun run lint && bun run typecheck && bun run test && bun run knip
```

**Never run bare `bun test`.** `bun run test` is a scoped script (`bun test ./src/ ./tests/
./scripts/`); the bare form walks the whole tree and, once `openshell-fork/target/` holds a
bundled-z3 build, picks up z3's own vendored JS test file and reports phantom failures that
have nothing to do with this project.

## Tests use synthetic state only

Never point a test at real credentials, the real dev gateway, or the real config directory —
always synthetic state, always cleaned up after. This project has lost real credentials to
test runs before. Project-specific isolation seams exist for this: `OPENLOCK_CONFIG_DIR` and
`OPENLOCK_DISPOSABLE_HOST`. `XDG_CONFIG_HOME` is **not** an isolation lever — podman honours it
and child processes inherit it, so it leaks straight through instead of isolating anything.
"Back up the user's real state first, then run the test" is an anti-pattern, not a mitigation —
if a test seems to need real state, that's a sign to add a proper seam, not to proceed.

## `main` is protected by a ruleset

`main` is guarded by a repository **ruleset**, not classic branch protection — `gh api
repos/vessux/openlock/branches/main/protection` returns 404 `Branch not protected`, which is a
misleading answer, not an absence of rules. Check `gh api repos/vessux/openlock/rules/branches/main`
instead. Never push directly to `main`; land changes via a PR.

## The backlog lives in beads

This project tracks its durable backlog with `bd` (beads):

```
bd ready -n 50          # THE backlog: authoritative for "what can I start now"
bd show <id>            # issue detail
bd create --title=... --description=... --priority=N --type=task|feature|bug|chore
bd update <id> --claim  # claim atomically
bd close <id>           # done
```

`bd ready` **is** the backlog — if it answered your question, you don't need a second roster
query.

## Conventions

- `docs/` is tracked and public; `.local/` is gitignored and holds long-form working artifacts
  (specs, plans, ad-hoc notes) that never need to ship.
- `CHANGELOG.md` is touched at release time only. Feature PRs do not add an "Unreleased"
  section; the release PR aggregates the window into one curated entry.
- No implicit provider selection: never infer or auto-select a provider. Require an explicit
  flag, env var, config value, or manifest entry, or error out.

## On-demand skills

`.claude/skills/` holds versioned, on-demand procedures — load one when its trigger applies,
rather than carrying it in context always. Unlike the rest of `.claude/`, this directory is
tracked.

- `fork-upstream-sync` — syncing the vendored fork to a new upstream release.
- `stacked-prs` — creating, pushing, or merging a `gh stack`.
- `debug-sandbox-auth` — an unexplained auth failure talking to a provider from inside a sandbox.
- `test-isolation` — writing or reviewing a test that touches config, credentials, the gateway, or a sandbox.

## Where the rest lives

This file stays intentionally short. For everything else:

- `README.md` — human dev setup and the golden path.
- `docs/` — user-facing documentation (start at `docs/README.md`).
- `docs/releasing.md` — how a release is cut.
- `docs/maintainers/fork-sync.md` — the fork upstream-sync runbook.

Don't restate their content here; keep this file pointing at them instead.
