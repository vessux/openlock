# Releasing

How a release is actually cut, across both repos and the container registry.

This exists because the process spans two repositories with **different release models**, plus a
registry whose lifecycle is different again — and none of that is discoverable from any single
place. Everything here has been verified against the workflows and the registry rather than
recalled.

Scope: this document starts once you have a fork state you want to ship. The fork **upstream-sync**
ritual that produces that state — rebasing the delta onto a new upstream, squeezing it, pre-flighting
proto collisions — is **not in this repository** and is not linked here on purpose: it currently lives
only in a maintainer's local, untracked agent-instruction file, so any link from a tracked doc would
dangle for everyone else. Bringing maintainer guidance into a committed file is tracked as
`openlock-yya`; until that lands, treat the sync ritual as an external prerequisite.

---

## The two repositories at a glance

| | `vessux/OpenShell` (the fork) | `vessux/openlock` |
|---|---|---|
| What ships | `openshell` CLI, gateway, sandbox supervisor binaries | the `openlock` CLI binary |
| Release from | a per-minor **release line** (`release/0.8`, `release/0.9`, …) | **`main`** |
| `main` is | a never-rewritten **mirror of `upstream/main`** — carries none of the delta | the actual product |
| Cut by | pushing a `vX.Y.Z` tag on the release line | pushing a `vX.Y.Z` tag on `main` |
| Installed directly by users | **No.** openlock downloads its binaries by pinned tag | Yes, via `install.sh` |
| Version pinned where | `OPENSHELL_FORK_TAG` in `src/sandbox/fork-binaries.ts` | `package.json` + the tag |

The asymmetry is the thing to internalise: **the fork releases from a branch that is not `main`,
openlock releases from `main`.** Both are correct. The fork's `main` must stay a byte-clean
upstream mirror (that is load-bearing for the sync ritual and for the no-public-name posture), so
the delta — and therefore every shippable state — lives on a release line.

### Which repo do I need to touch?

**Only cut a fork release if there are new fork commits.** A release whose fork delta is unchanged
reuses the existing `OPENSHELL_FORK_TAG` and needs no fork work at all. v0.11.2 was the first cut
this way and it was materially cheaper. Check with `git log <last-fork-tag>..release/X.Y`.

---

## Part 1 — Releasing the fork

Only when the fork delta actually changed.

1. Land the change on the release line (`release/X.Y`) as an ordinary commit. Never on `main`.
2. Run the **full** gate on the release-line tip — not a subset:
   ```
   cargo fmt --all -- --check
   cargo clippy --workspace --all-targets --features openshell-prover/bundled-z3 -- -D warnings
   cargo test --workspace --features openshell-prover/bundled-z3
   ```
   Each of these has caught something the others structurally could not. `-- -D warnings` is not
   optional: the project's own gate uses it, and a bare `cargo clippy` has reported clean while the
   real gate failed. `cargo test` is not optional either: a rebase once broke podman GPU passthrough
   while both `check` and `clippy` passed.
   > The Mac gate is **blind to `#[cfg(target_os = "linux")]` code** (supervisor, netns, bypass).
   > For changes touching those, cross-compile: `cargo-zigbuild clippy --target aarch64-unknown-linux-gnu`.
3. Tag `vX.Y.Z` on the release line and push the tag. `openlock release` (the fork's *only* active
   release workflow) builds the binaries. It is branch-agnostic, so releasing off a non-`main`
   branch needs no workflow change.
4. **Wait for the assets to publish — this takes hours, not minutes.** Then verify before pinning:
   the release is not draft/prerelease, its asset list matches the previous tag's, and the exact
   download URLs `fork-binaries.ts` constructs return 200 for darwin-arm64, linux-arm64 and
   linux-amd64. `bun scripts/print-fork-asset-urls.ts` emits them.
5. Bump `OPENSHELL_FORK_TAG` in openlock and open that as its own PR.

### The fork's inherited release workflows must stay disabled

Upstream ships four `Release *` workflows. All four are `disabled_manually` and **must stay that
way**:

```
Release Auto-Tag   disabled_manually
Release Canary     disabled_manually
Release Dev        disabled_manually
Release Tag        disabled_manually
```

`Release Auto-Tag` is the dangerous one. It runs on a **schedule**, checks out the **default
branch** (`main` — the delta-free mirror), and if `main` is ahead of the newest tag it creates and
pushes the next patch tag. Since `openlock release` fires on `v*.*.*` and openlock pins a **tag**,
that would publish a plausible-looking `vX.Y.Z` containing **no cred_inject, no `allowed_secrets`,
no per-binary credential scoping — the entire moat absent** — and steal the patch number the
release line wanted next.

**Deleting the workflow file cannot fix this.** On the release line it has no effect (schedules
read the default branch); on `main` it is forbidden (the mirror must stay byte-clean). The repo-level
switch is the only correct fix, and it costs zero fork delta.

**So: after any `git push origin upstream/main:main`, run `gh workflow list --all --repo vessux/OpenShell`
and confirm those four are still disabled and `openlock release` is still active.** An upstream-added
release workflow arrives through the mirror already enabled.

> Known harmless noise: `Build CI Image` fires on fork `main` pushes and targets NVIDIA self-hosted
> runners that do not exist here, so every mirror fast-forward that touches its paths spawns a run
> which hangs and is auto-cancelled at **24h**. All 6 recorded runs ended `cancelled`. It has never
> succeeded here and never will; it is noise, not signal. Disabling it is a reasonable cleanup but
> nothing depends on it.

---

## Part 2 — Releasing openlock

### Step 0 — Decide the version number, don't inherit it

Count what actually landed:

```
git log --oneline vX.Y.Z..main
```

Any `feat(...)` commit that changes a user-facing surface makes it a **minor** bump. A tracker issue
that says "cut v0.12.1" was written before the window's contents were known — v0.13.0 was cut against
exactly such a ticket because six `feat` commits had landed. **Recount; don't trust the title.**

### Step 1 — Preconditions

- `main` is green and you are up to date with `origin`.
- The pinned `OPENSHELL_FORK_TAG` release is published with a complete asset set (Part 1, step 4).
- Working tree clean.

### Step 2 — Harness pins

```
bun run harness:check          # reports drift per harness; NOT a CI gate
```

Bump `src/sandbox/harness-versions.ts` and refresh the literal version numbers in its doc comment —
they go stale silently. The dist-tag target differs per harness **on purpose**: `@anthropic-ai/claude-code`
publishes a curated `stable`; `opencode-ai` and `@earendil-works/pi-coding-agent` publish no `stable`
at all, only `latest`. Do not unify them.

> `stable` and `latest` can be far apart — at v0.13.0, `stable` was 2.1.226 while `latest`/`next`
> were 2.1.234. "Newest stable" is deliberately not "newest published".

### Step 3 — Live-verify every harness you bumped

**This is not optional and it is not covered by any automated gate.** At v0.13.0 the entire suite
(lint, typecheck, knip, 1405 tests) was green while opencode was completely broken in the sandbox.

For each bumped harness, in a real sandbox on podman:

1. Scaffold a throwaway project, confirm `.openlock/Containerfile` renders the new pin.
2. Create the sandbox, confirm `<harness> --version` **inside** it reports the expected version.
3. Round-trip **real inference** and match a **computed** answer (e.g. `468 + 279` → `747`).
   Never ask the model to echo a token — your own prompt echo on screen is a false pass.
   **Vary the value between runs** so a cached transcript or stale image cannot produce it.
4. Confirm `grep -c "L7 relay error"` over the sandbox log is `0`. That log is *asymmetric* — blind
   to `cred_inject` success, loud on its failure — so an empty count is the positive signal.
5. Clean up the sandbox.

**Drive it through the attach path, not `openlock exec`.** `exec` does not stage the provider's
`sandboxEnvPlaceholders`, so `OPENROUTER_API_KEY` is unset there and opencode/pi fail under it. The
trick is to put the whole invocation in the project's `args:` — `harnessLaunchArgv` is
`[<binary>, ...args]`, so `args: [run, --model, X, "prompt"]` makes attach run it non-interactively
with the full environment. **Attach needs a real PTY**; with no TTY it hangs silently producing no
output at all.

Recorded because each cost real time:

- A `curl` from inside the sandbox to an allowed host is **DENIED by the per-binary moat**
  (`binary '/usr/bin/curl' not allowed in policy '<harness>'`). It returns `HTTP 000` /
  `CONNECT tunnel failed, response 403`, which looks exactly like broken egress. **curl is not a
  valid probe.** Read `/var/log/openshell*.log` inside the container — it names the binary and reason.
- An OpenRouter **404 guardrail** or a provider **429** *proves* `cred_inject` worked: the request was
  authenticated upstream, then refused on model policy or capacity. **Only a `401` is the failure
  signal.**
- openrouter model addressing is `<provider>/<openrouter-id>`, so the free router is the doubled
  `openrouter/openrouter/free`. That works for opencode; pi needed a concrete model.
- Check `openlock providers` shows `stored=yes` before planning any openrouter verification — that
  credential has gone missing before.

### Step 4 — Version, changelog, gates

- `package.json` `version`. (It is the only other place the version lives; there is no lockstep file.)
- **CHANGELOG.md** — feature PRs deliberately do **not** touch it; the release PR aggregates the whole
  window into one curated entry. Sections in use: `Added` / `Changed` / `Fixed` / `Testing and CI` /
  `Verified`. The `Verified` section is a deliberate habit: record what was checked *empirically*,
  and record verification debt a release did not pay.
- Gates: `bun run lint && bun run typecheck && bun run test && bun run knip`.
  **`bun run test`, never bare `bun test`** — the package script is scoped; bare `bun test` walks into
  `openshell-fork/target/` and reports phantom failures from z3's own vendored JS tests.
- If you touched anything that renders policy, `bun run render:policies` — the drift guard will fail
  the suite first, which is it working.

### Step 5 — PR, merge, tag

`main` is protected by a **ruleset**, not classic branch protection (`.../branches/main/protection`
returns 404 `Branch not protected`, which is misleading — use `gh api repos/vessux/openlock/rules/branches/main`).
Required checks: `test`, `CodeQL`, `Analyze (javascript-typescript)`. `live-integration` is **not**
required, so a PR can read `UNSTABLE` with only that leg pending and still be mergeable — **wait for
it anyway**, podman is the primary runtime.

Then squash-merge, and tag on `main`:

```
git checkout main && git pull
git tag -a vX.Y.Z -m "..."
git push origin vX.Y.Z
```

### Step 6 — Verify the artifact you actually shipped

The tag push fires `release` (3 binaries + checksums) and `base-image`. Do not stop at "workflow
green":

```
gh release view vX.Y.Z --json isDraft,isPrerelease,assets
gh release download vX.Y.Z --pattern "openlock-aarch64-apple-darwin.tar.gz"
tar -xzf ... && ./openlock --version        # must report X.Y.Z (<squash-sha>)
shasum -a 256 -c checksums-sha256.txt
```

The embedded build SHA should be the **squash commit**, which is how you know the artifact came from
the merged state and not something else.

---

## Part 3 — Container images

Short answer: **there is exactly one published image, it is content-addressed, and it is never
promoted or pruned.**

### `ghcr.io/vessux/openlock-base:<hash>` — the only published image

- `<hash>` is `sha256(containers/base.Containerfile)[0..12]` — computed identically by CI and by the
  host (`src/sandbox/ensure-base.ts`, `computeBaseTag`). Verify with `openlock --print-base-tag`.
- **There are no `latest`, no `vX.Y.Z`, and no moving tags.** The content *is* the identity. A given
  `base.Containerfile` always maps to the same tag, so rebuilding is idempotent and the workflow
  skips the (QEMU-emulated, 10–15 min arm64) build whenever the tag already exists.
- Multi-arch: `linux/amd64` + `linux/arm64`, pushed with `provenance: false` — buildx provenance
  attestations can trip podman's arch selection.
- **Publicly readable.** Verified unauthenticated. This matters: end users pull it without
  credentials. If a future package ever comes back private, `podman pull` fails for everyone and
  silently degrades to a slow local build.
- As of v0.13.0 exactly **three** tags exist (`c00459a7735d`, `2da46a0c4e1f`, `9c3d53d34b63`).
  Old tags are **never deleted**, and that is load-bearing — see the migration trap below.

Built by `.github/workflows/base-image.yml` on **release tags** *and* on **`main` pushes touching
`containers/base.Containerfile`**. The tag trigger is the durable per-release guarantee (a released
binary embeds a frozen `base.Containerfile`, so its hash must exist in ghcr). The main-branch trigger
closes the window where a merged base change is unbuilt until the next release, making every
live-integration run and fresh install pay a full local rebuild.

> **Do not "fix" the tags-vs-paths combination in that workflow.** It looks like `paths:` would also
> gate the tag trigger — which would be release-breaking. It does not: GitHub does not evaluate path
> filters for tag pushes. This is documented in the workflow header; leave it.

### The migration trap that follows from content addressing

`openlock init` bakes the base tag into each project's `.openlock/Containerfile` as a **literal**
`FROM ghcr.io/vessux/openlock-base:<hash>`. Because old tags are never deleted, that literal keeps
resolving forever — so **a base image fix does not reach existing projects, and upgrading the CLI
does not change that.** Users must run `openlock update-base --project <dir>` and force a rebuild.

Since v0.13.0 this is at least *visible*: `detectBaseImageDrift()` warns in both `openlock doctor`
and the `openlock sandbox` preflight. It warns and never blocks, because a stale pin builds fine and
may be deliberate.

**But nothing announces it at upgrade time, and that is the assumption most likely to mislead you
when deciding whether a release needs a migration note.** Installing a new CLI prints nothing about
the base image — `install.sh` reports the install path and runs `doctor` in whatever directory you
happen to be in, which is usually not a project. The drift warning is *reactive and per-project*: it
fires only the next time you run `openlock doctor` or `openlock sandbox` **inside** an affected
project. So a user with five projects gets five separate warnings, each deferred until they next
touch that project — possibly weeks later, possibly never for one they have parked. Nobody is ever
told "this upgrade changed the base; N of your projects are now stale".

That is a real gap, not a design intent, and it is filed as `openlock-u7ca` (the outgoing binary is
still on disk when `install.sh` runs, and both versions can self-report their base hash offline in
~40ms, so the comparison is cheap and available). Until it ships:

**Any release that changes `base.Containerfile` needs an explicit migration note in the changelog**,
because the changelog is the only surface that will actually tell anyone. The nftables fix (#133)
stranded every pre-existing project.

### `openlock-sandbox:<hash>` — local only, never published

Each project's own image, built on the host from its `.openlock/Containerfile` and tagged
`localhost/openlock-sandbox:<hash>`. It is never pushed anywhere and has no registry lifecycle.
Reclaim unreferenced ones with `openlock prune-images`.

### The fork publishes no images

The fork ships **binaries only** — the 9-asset release set that `fork-binaries.ts` downloads by
pinned tag. Upstream's image workflows (`Docker Build`, `Build CI Image`) either never run here or
hang against absent self-hosted runners. **Nothing in openlock pulls a fork-built image**, so the
fork has no registry lifecycle to manage.

---

## Part 4 — Prereleases

**The mechanism already exists and has precedent; what is missing is a rule for when to use it.**

`release.yml` marks a release as prerelease automatically:

```yaml
prerelease: ${{ contains(env.RELEASE_TAG, '-rc') || contains(env.RELEASE_TAG, '-beta') || contains(env.RELEASE_TAG, '-alpha') }}
```

And it is safe by construction: `install.sh` resolves the default install through the GitHub
`releases/latest` endpoint, which **excludes prereleases**. So an `-rc` tag is invisible to ordinary
installs and reachable only by an explicit `OPENLOCK_VERSION=vX.Y.Z-rc1`. Nobody is upgraded into an
rc by accident.

There is precedent: `v0.9.1-rc1` was cut for the 2026-06-18 upstream sync, and that rc gate caught
two real release-blockers (an amd64 build timeout and a bundled-z3 SIGILL on CPUs without AVX2) that
would otherwise have shipped.

**Proposed rule — cut an `-rc` when the release carries build-shape or platform risk that local
gates cannot see:**

- a fork pin bump (new binaries, new platform matrix), especially after an upstream sync;
- any change to `release.yml`, the build target list, or compile flags;
- a `base.Containerfile` change (multi-arch build, QEMU-emulated arm64);
- a dependency change that alters the compiled bundle.

Conversely a pure-TypeScript bugfix release does not need one — the `test` job already covers it.

**The rc must be exercised on a machine that is not the dev box**, since its entire value is catching
what the dev machine cannot: install from the rc tag via `install.sh` with an explicit
`OPENLOCK_VERSION`, on both architectures if the change is build-shaped. Promote by tagging the final
`vX.Y.Z` on the same commit.

> Not yet mechanised: nothing *enforces* an rc for the categories above, and no workflow gates a
> final tag on a prior rc having been installed. Treat this section as the policy until it is.

---

## Traps, collected

- **The version in the ticket is a guess.** Recount `feat` commits.
- **A dist-tag can move mid-release.** claude-code's `stable` advanced during the v0.13.0 cut. If you
  bump, **re-verify from a rebuilt image with a fresh computed value** — never inherit the earlier
  run's result.
- **Green gates prove nothing about a harness bump.** Live-verify or don't bump.
- **`openlock logs <session>` can hang and produce nothing.** Read `/var/log/openshell*.log` inside
  the container instead.
- **`openlock init --force` resets `config.yaml`**, discarding any `args:` you added.
- **Only cut a fork release if there are new fork commits.**
- **Never bare-renumber a fork proto field**, least of all `NetworkPolicyRule.allowed_secrets = 4`.
  Absence is indistinguishable from empty on the wire, and empty means "all credentials resolvable" —
  so renumbering fails **open** on the moat. See the field's own comment for the dual-write path.
