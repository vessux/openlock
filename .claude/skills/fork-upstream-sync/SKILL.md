---
name: fork-upstream-sync
description: Use when syncing the vendored fork (openshell-fork/) to a new upstream release, or landing any commit on a release/X.Y line.
---

Full runbook: `docs/maintainers/fork-sync.md`. Read it before starting — this skill is only the
checks that are catastrophic to skip if you improvise the sync from memory instead.

## Before you do anything else

Fast-forwarding the mirror (`git push origin upstream/main:main`) looks harmless by itself, but
it arms a scheduled upstream workflow that can tag a moat-free release straight off the
delta-free mirror if the next step is skipped.

**After every mirror fast-forward:** run `gh workflow list --all` and confirm only this
project's own release workflow is active. A newly-added upstream release workflow arrives
through the mirror already enabled, with no other signal that it exists.

## Non-negotiable checks, in order

1. **Squeeze the delta before rebasing** onto the new `release/X.Y` line. The squeezed tree must
   be byte-identical to the pre-squeeze tip — verify with an empty `git diff` *and* matching
   tree hashes, not by eyeballing the diffstat.
2. **Pre-flight proto collisions before resolving any other conflict, all three classes:**
   fork-added numbering at 9000+; upstream repurposing the *type* of a field number the fork
   already shares with it (a 9000+ grep cannot find this one — diff by number → (type, name));
   and the one legacy fork field that sits below 9000. Never bare-renumber a fork proto field —
   absence is indistinguishable from empty on the wire, and empty fails open on a
   security-critical decision for any version-mismatched peer.
3. **Run the full gate on the final tip, not a subset:** `cargo fmt --all -- --check`, `cargo
   clippy --workspace --all-targets --features openshell-prover/bundled-z3 -- -D warnings`, and
   `cargo test --workspace --features openshell-prover/bundled-z3`. Each has independently caught
   a real regression the others could not — `-- -D warnings` and `cargo test --workspace` are
   not optional shortcuts, even when `check`/bare `clippy` are clean.
4. **Smoke-test on a fresh gateway** before trusting the sync. The sandbox-to-gateway contract
   breaks only at runtime, never in the unit suite.

Stopping after reading only this file does not destroy anything — but it also isn't the sync.
`docs/maintainers/fork-sync.md` has the full ritual, the reasoning behind each check, and the
exact commands for every step above.
