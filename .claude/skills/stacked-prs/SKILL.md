---
name: stacked-prs
description: Use when creating, pushing, or merging a gh-stack (github/gh-stack) — a set of dependent PRs where each layer's base is the layer below it.
---

`gh stack` splits one large change into reviewable layers, each PR based on the layer below it.
Ordinary single PRs stay the default; reach for this only when one PR would be unreviewable.

## Creating and pushing

- `gh stack init <branch>` / `gh stack add <branch>` / `gh stack checkout <pr-number>` all want
  an explicit branch name argument. Without a TTY the interactive form fails immediately with
  "interactive input required" rather than hanging — always pass the name.
- `gh stack add <branch>` must be run **from a branch already in the stack** — it creates and
  checks out the new layer itself. Doing the natural thing (`git checkout -b foo` first, then
  `gh stack add foo`) fails with "current branch `foo` is not part of a stack", because by the
  time `add` runs you're standing on a branch the stack has never heard of.
- Stack metadata lives in `.git/gh-stack`, is **never committed**, and does not travel between
  machines — only the branches and PRs do. Adopt a stack on another host with
  `gh stack checkout <pr-number>`; don't expect `gh stack view` to already know about it there.
- `gh stack submit --auto` opens **every** PR in the stack as a DRAFT. Pass `--open` alongside it
  (`gh stack submit --auto --open`) to create them ready for review instead and skip the
  draft-clearing dance below entirely. `--auto` is also implied when there is no TTY, so a
  non-interactive `gh stack submit` with no flags still produces drafts.

## Merging

- **Merging is `gh stack merge --yes`, not `gh pr merge`.** A stack merges atomically —
  everything up to and including the chosen PR lands in one all-or-nothing operation and GitHub
  rewires the bases underneath as part of it; `gh pr merge` only knows about a single PR and
  cannot do that.
- Clear the draft state before merging (unavoidable only if you did not submit with `--open`):
  `gh stack merge` fails with `nothing to merge: pull request #N is a draft`, naming only the
  **first** draft it hits — so it reads like a one-PR
  problem when in fact none of them are ready. Use `gh pr ready <n>` per PR, or check
  `gh pr view <n> --json isDraft` across the whole stack up front.
- A required status check whose workflow filters `pull_request` on `branches: [main]` makes
  every layer above the bottom one **permanently unmergeable**. Only the bottom PR has base
  `main`; the rest are based on the layer below, so the workflow never fires on them and they
  sit forever waiting on a check that structurally cannot run.
  - If you fix such a workflow, **the fix must be rebased into the branches, not just merged to
    `main`.** For `pull_request` events GitHub reads the workflow file from the PR's own head,
    not from the base — so merging the fix into `main` does nothing for already-open stacked
    PRs. `gh stack rebase` (pulls the fix into every layer) then `gh stack push` is what
    actually turns the checks on.
- `gh stack view` needs no `--json` when run without a TTY — it prints a plain text tree, not a
  TUI.
- A failed `gh stack merge` leaves nothing partially merged; a refusal is always safe to retry
  once its cause is fixed.

## After a merge

- Squash-merge means `git branch -d` refuses (the branch looks unmerged from git's own point of
  view) — use `git branch -D` plus `git push origin --delete`.
- Verify the whole stack actually landed by diffing the **top** branch against `main`: it's
  cumulative, so an empty diff proves everything landed. The lower branches will each still show
  a large diff, because they lack the layers stacked above them — that's expected, not a
  warning sign.
- Run `gh stack unstack <number> --local` to drop local tracking for a merged stack — note that
  `unstack`, unlike `merge`, takes **no** `--yes` flag. `.git/gh-stack` accumulates every stack
  ever created and never prunes itself, so skipping this after a merge makes a later `unstack`
  progressively harder to run (multiple stacks sharing a trunk branch need an explicit stack
  number to disambiguate).
