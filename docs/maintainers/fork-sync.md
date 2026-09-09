# Fork upstream-sync runbook

How `openshell-fork/` (openlock's vendored fork of `NVIDIA/OpenShell`) gets synced to upstream.

This is a maintainer runbook, not contributor onboarding — you need it when there are new
upstream commits to absorb into the fork, not when working on openlock itself.

Scope: this document starts once you've decided to run a sync. It assumes familiarity with
`docs/releasing.md`, which covers what happens *after* a synced fork state is ready to ship.

## The release-line model

Fork `main` is a **never-rewritten mirror of `upstream/main`**. It carries none of the fork's
delta (`cred_inject`, per-binary credential scoping, the openlock release workflow, and
everything else that makes this fork exist). The delta itself lives on a per-minor **release
line** — `release/0.8`, `release/0.9`, and so on. Each upstream cycle opens a *new* line instead
of force-pushing the old one.

This supersedes an earlier force-push-`main` flow. The release-line model is better on every
axis that mattered: the force-push disappears from the critical path entirely (fast-forwarding a
mirror is a plain push, no `--force`, no human gate), every shipped tag keeps an immutable record
of exactly what upstream state it was built from, and hotfixes have somewhere to land without
disturbing the mirror.

**Do not switch to merging `upstream/main` in to dodge the rebase.** It's tempting because a
merge never conflicts the way a rebase does, but it destroys the clean patch series — and that
patch series is what the drop-fork cost accounting and the whole upstreaming story are measured
against. A merged history buries the delta inside upstream's commits instead of keeping it as a
reviewable, re-appliable series.

## The ritual

1. **Fast-forward the mirror.**

   ```
   git fetch upstream
   git push origin upstream/main:main
   ```

   This never needs `--force` — `main` only ever moves forward to match upstream.

2. **Squeeze the delta first.** This is a standing per-cycle ritual, not a one-off cleanup. Before
   rebasing, re-author the fork's delta into the fewest honest changesets, so the sync carries N
   conflict resolutions instead of one per historical commit. Split by **feature**, not by old
   commit boundary, and attribute hunks by reading the *final* content rather than replaying old
   diffs. Pure rebase-friction commits — sync-adaptation commits, fixture renumbering, anything
   that only exists because of a previous rebase — must vanish entirely rather than get carried
   forward.

   Hard safety property: the squeezed tree must be **byte-identical** to the pre-squeeze tip.
   Verify with an empty `git diff <new> <old>` and by comparing tree hashes, not just by eyeballing
   the diffstat. Each resulting changeset should independently pass the workspace build — a
   changeset that only compiles once later changesets land isn't a real unit.

   **Check whether upstream has since shipped a fork feature, and drop ours if so.** Every fork
   feature is conflict surface; one upstream has implemented natively is pure cost. The 0.9 sync
   dropped the fork's Stop/Start lifecycle (upstream #2653 shipped a superset: same CLI verbs, same
   `"Stopped"` phase label, plus a `STOPPING` phase) — after confirming openlock only reads the exit
   code and a later `sandbox get`. When you drop a feature, the byte-identity check still holds
   *modulo the drop*: revert the dropped feature's commit on the old tip and compare tree hashes
   against the squeezed tip. If the revert doesn't apply cleanly, the feature is entangled with
   something you are keeping — untangle by hand and say so in the commit message.

3. **Cut the release line.** Branch `release/X.Y` off the freshly-synced `main` and replay the
   squeezed delta onto it (`git rebase upstream/main` from the delta branch is equivalent). That
   state becomes `vX.Y.0`.

4. **Resolve conflicts — pre-flight proto collisions before anything else.** There are three
   classes, and the second and third are easy to miss because a naive grep only catches the first:

   - **Fork-added numbering.** Fork additions live at field numbers 9000+. Grep both sides
     (`git grep '= [89][0-9]{3}'` on the fork vs. `git show upstream/main:proto/...`) to confirm
     upstream hasn't claimed the same range.
   - **Type or semantic changes to field numbers the fork already shares with upstream.** Upstream
     can repurpose a pre-existing field *in place* — same number, different type — and no 9000+
     grep will ever surface that, because the number isn't new. The only reliable check is to diff
     every field the fork touches against upstream's current proto by **number → (type, name)**,
     not just by number. This has happened for real: a fork field that was a plain `bool` at the
     merge base got changed upstream, in place, to a message type as part of an unrelated refactor,
     while the fork still carried the old `bool` — a silent type mismatch that would have broken
     every driver consuming that field. Also check for fields upstream has since marked `reserved`
     while the fork still uses them live, and for new upstream fields worth adopting.
   - **Legacy fork claims below 9000.** Before the 9000+ convention existed, one field landed in
     upstream's own sequential range: the per-binary credential-scoping field on
     `NetworkPolicyRule` — the security-critical field this whole fork exists to carry. No 9000+
     grep can find it, because it isn't at 9000+.

     Detection here is automatic and needs no extra guard: a duplicate field number makes protoc
     hard-fail the build with an explicit "field number already used" error, so a collision
     surfaces during the sync and can never ship silently. The real hazard is **mis-resolving**
     that failure. Never bare-renumber the field. On the wire, an absent field is indistinguishable
     from an empty one, and for this particular field empty means "all credentials resolvable" —
     so renumbering it fails **open** on the credential-scoping path for any peer running a
     version-mismatched build. The safe path is documented in full in the field's own comment in
     the proto source (a three-phase dual-write, not a renumber).

     Related convention: when removing a fork field entirely, use `reserved <n>; reserved
     "<name>";` rather than deleting the line. Removal is wire-safe — old peers' values for a
     reserved field are just ignored as unknown bytes — but renumbering is what breaks cross-
     version decode.

   Then — before resolving the Rust conflicts — pre-flight the one collision class that is not a
   proto at all: **a new upstream path that resolves credentials.** The per-binary
   `allowed_secrets` moat is a *filter wrapped around a resolver* (`filter_resolver_by_policy` in
   `supervisor-network/src/proxy.rs`). It protects exactly the resolvers it wraps and nothing
   else, so any upstream refactor that constructs or swaps in a resolver somewhere new is a
   fail-open hole until proven wrapped — and the unit suite cannot see it, because every test
   passes with the filter covering nothing. The 0.9 sync hit this for real: upstream v0.0.116
   materialises sandbox credentials as `ProviderCredentialState` and swaps in a per-request,
   endpoint-scoped resolver in `l7/relay.rs` (`scoped_context_for_request`), bypassing the
   filtered `ctx.secret_resolver` entirely; a second upstream branch forwarded the header block
   *before* the `cred_inject` strip-and-replace ran. Grep both sides for `SecretResolver`
   construction sites, `secret_resolver =` assignments, and any new `*_credentials` state, and for
   each new site either route it through the filter or argue in the commit message why it cannot
   carry a credential.

5. **Run the full gate on the release-line tip — not a subset.**

   ```
   cargo fmt --all -- --check
   cargo clippy --workspace --all-targets --features openshell-prover/bundled-z3 -- -D warnings
   cargo test --workspace --features openshell-prover/bundled-z3
   ```

   Each command has independently caught something the others structurally could not:

   - `cargo fmt --all -- --check` matters because rebase conflict resolution reliably produces
     mis-wrapped lines that compile and lint clean. A prior sync shipped unformatted delta because
     only check/clippy/test were run. `cargo fmt` may also reorder `pub mod` declarations and add
     trailing commas inside rewrapped calls — both semantically inert, but verify that by stripping
     whitespace and comparing, not by eyeballing.
   - The `-- -D warnings` on the clippy invocation is load-bearing, not decoration. The project's
     own gate runs with it (`unused_qualifications` and clippy's `pedantic`/`nursery` groups are at
     warn), and a bare `cargo clippy` has reported clean while the real gate failed. A real
     instance: taking upstream's fully-qualified path at a conflict hunk while keeping the fork's
     existing `use` of the same type introduced ten `unnecessary qualification` warnings — invisible
     to a bare `cargo check` and a bare `cargo clippy` alike.
   - `cargo test --workspace` is not optional. `check` and `clippy` are structurally blind to
     behavioral breaks: one rebase's conflict resolution silently broke podman GPU device
     passthrough by hardcoding a resource field to `None` in a test helper, bypassing upstream's
     resolution layer entirely — and that passed both `cargo check` and `cargo clippy -- -D
     warnings` cleanly. Only the test suite caught it, as two failures out of several thousand. Run
     the full suite on the final tip of every sync, and again on any changeset whose resolution
     touched a function signature.

   > **The Mac gate is blind to `#[cfg(target_os = "linux")]` code** — the supervisor, netns, and
   > bypass-detection paths, which is to say much of what the fork's security model depends on,
   > since the supervisor only runs inside the Linux container. `cargo clippy`/`cargo test
   > --workspace` on macOS never compile that code at all; a green result proves nothing about it.
   > Run the Linux leg on **every** sync, not only when you believe you touched those paths — a
   > mechanical conflict resolution can leave a `#[cfg(target_os = "linux")]` test literal missing
   > a fork field, and the 0.9 sync's Mac gate was fully green with exactly that break in it:
   >
   > ```
   > mise trust <clone>/mise.toml   # zig comes via the mise shim; untrusted config = silent failure
   > cargo-zigbuild clippy --target aarch64-unknown-linux-gnu --workspace --all-targets \
   >   --features openshell-prover/bundled-z3 -- -D warnings
   > ```
   >
   > Note the hyphenated binary: `cargo zigbuild clippy` (as a cargo subcommand) is rejected with
   > "unexpected argument 'clippy'". The general lesson: whenever a gate reports green, ask what
   > that gate structurally cannot see before trusting it.

   **z3 note.** `cargo tree -i z3-sys` is the source of truth for who pulls z3 in — this has
   changed upstream before, so don't assume the previous sync's answer still holds. For manual
   cargo commands that touch the gateway, append the bundled-z3 feature (`--features
   openshell-prover/bundled-z3` at workspace scope). The first build compiles z3 from source
   (roughly three minutes); after that it's cached in `target/`, and ordinary source edits don't
   trigger a rebuild — only `cargo clean`, a `Cargo.lock` change, or a feature-set change does.
   If you'd rather not build it at all, a system z3 works too: install it and point the build at
   it with `Z3_SYS_Z3_HEADER=<prefix>/include/z3.h LIBRARY_PATH=<prefix>/lib`, dropping the
   bundled-z3 feature.

6. **Push the release line.** Plain new-branch push — no `--force`, no human gate, nothing to
   overwrite. Open a PR only if you want a review artifact for the conflict resolutions and proto
   decisions; a PR whose diff against `main` is empty (which is what a pure squeeze produces) isn't
   a useful review artifact — review locally with `git log -p` instead.

7. **Tag and release.** Tag `vX.Y.0` on the release line and push the tag; the release workflow
   builds binaries from it. That workflow triggers on any `v*.*.*` tag push and is branch-agnostic,
   so releasing off a non-`main` branch needs no workflow change. See `docs/releasing.md` for what
   happens from here (asset verification, bumping the pinned tag in openlock, and so on).

8. **Later fixes land on the same line** as ordinary commits (`vX.Y.1`, `vX.Y.2`, ...). The line
   stays open until the next upstream cycle opens `release/X.(Y+1)`.

## Inherited upstream release workflows must stay disabled

Upstream ships several `Release *` workflows. All of them are disabled and must **stay** disabled;
only the project's own release workflow stays active.

The dangerous one runs on a **schedule**: it checks out the **default branch** — `main`, the
delta-free mirror — and if `main` is ahead of the newest `v*.*.*` tag, it creates and pushes the
next patch tag. This is silent today only by coincidence: because a release line is `main` plus
delta, `main` is normally an *ancestor* of the newest tag, so the "anything new to tag" check
comes back empty. **Step 1 of this very ritual — fast-forwarding the mirror — is exactly what
breaks that coincidence.** Once `main` moves past the base a release line was cut from, the
scheduled workflow tags the next patch number on the delta-free mirror, and the project's own
(branch-agnostic) release workflow happily publishes it: a plausible-looking `vX.Y.Z` release
containing no credential injection, no per-binary credential scoping — the fork's entire reason
for existing, silently absent. It would also steal the patch number the real release line wanted
next.

**Deleting the workflow file cannot fix this.** On the release line it has no effect, because
scheduled runs read the default branch regardless of what any other branch contains. On `main` it
is forbidden outright, because the mirror has to stay byte-clean for the sync ritual to work at
all. The only correct fix is the repository-level workflow-disable switch —
and it's a good fix, not just the least-bad one: it costs zero fork delta and survives every sync
untouched, unlike a file-level change that a future fast-forward would just overwrite anyway.

**So: after every `git push origin upstream/main:main`, run `gh workflow list --all` and confirm
only the project's own release workflow is active.** A future upstream release workflow would
arrive through the mirror already enabled, with no signal other than this check.

Of the workflows that *should* stay enabled, only the CI image build is gated to `branches:
[main]`, and only on paths the delta never touches — so no delta work loses CI coverage by living
on a release line instead of `main`.

## Smoke-test after every sync

After a sync, before trusting it, smoke-test on a real host with a fresh gateway (stop and restart
it). Changes to the sandbox-to-gateway contract — auth, proto shape, policy evaluation — surface
only at runtime; the unit test suite says nothing about them no matter how many tests pass.
The cheapest real host is the openlock pin-bump PR itself: its podman and docker live legs create
a sandbox with the freshly released binaries and drive cred_inject through the moat.

Before that, diff the **CLI argument surface** openlock drives, not just the gRPC one: every clap
attribute on `sandbox create` / `exec` / `upload` in `crates/openshell-cli/src/main.rs`
(`conflicts_with`, `requires`, `last = true` positionals, new defaults) against the
`buildOpenshell*Argv` builders in openlock's `src/sandbox/container.ts`. A new conflict is a hard
exit 2 at create with zero unit-test signal. The 0.9 sync hit this: upstream #2726 made the
trailing command the sandbox's canonical main process and rejected `--upload` next to it, while
openlock passed both and its setup script read the upload — the fix was create `--detach`, then
`sandbox upload`, then a marker the setup script waits on (see `buildOpenshellCreateArgv`).

When a sync does surface an integration gap, **fix it on the openlock side, not with a fork
patch.** Every line of fork delta is conflict surface for the next sync; a mandatory new
supervisor requirement, for instance, is better absorbed by having openlock provision what the
supervisor now needs than by patching the supervisor to not need it.
