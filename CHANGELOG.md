# Changelog

## Unreleased

### Changed

- **`openlock --version` now appends the build commit SHA** (e.g. `0.9.1 (a1b2c3d)`) when built in release CI, so a specific build is identifiable — including across force-moved pre-release tags. Local `bun run` still prints the bare version. The SHA is injected at compile time via `bun build --define`.

### Fixed

- **`doctor` no longer false-negatives when both podman and docker are installed.** The non-interactive runtime resolver only auto-picks when *exactly one* runtime is present; with both installed it returned `null`, which `doctor` rendered identically to "no runtime installed" (a misleading `✗ container runtime (podman/docker)` with an "install one" hint). `doctor` now probes both and reports **every** installed runtime plus its readiness (podman API socket / docker daemon / podman machine on macOS), so a host with both shows both. Session preflight still checks only the runtime it resolved.
- **x64 Linux binary runs on non-AVX2 CPUs.** The `openlock-x86_64-unknown-linux-gnu` release artifact is now built with Bun's `bun-linux-x64-baseline` target (x86-64-v2: SSE4.2/POPCNT, no AVX2). The previous `bun-linux-x64` build required AVX2 and crashed with `Illegal instruction (core dumped)` on older/limited CPUs the moment the binary ran (e.g. at the post-install `openlock doctor`).
- **`install.sh` usage and docs now pipe to `bash`, not `sh`.** The script's shebang and `set -euo pipefail` require Bash; the documented `| sh` invocation failed on Debian/Ubuntu (where `sh` is `dash`) with `Illegal option -o pipefail`.

## v0.9.0

### Added

- **Onboarding wizards — `openlock setup` and `openlock init`.** `setup` writes machine-wide defaults (runtime / harness / provider) to `~/.config/openlock/config.yaml`, with the provider list filtered to harness-compatible ids. `init` scaffolds a project's `.openlock/` — a commented `config.yaml` with a real workdir mount, a harness-trimmed `policy.yaml`, and a seeded `Containerfile` — via a fresh-entry fork (defaults or guided Q&A), gap-filling missing files without clobbering a complete folder (use `--force`). Non-TTY runs print a manual-config hint and exit non-zero.
- **`openlock validate`.** Checks a project's `.openlock/` config and policy — structure, semantic mount rules, and filesystem source existence — against a single shared rule source, printing a per-file summary. Replaces the narrower `validate-policy` command.
- **Slim, single-image sandbox with a multi-harness model.** One `base.Containerfile` (Ubuntu + Node + Python 3 + uv, with sha256-pinned Node/uv tarballs) replaces the previous four-capability image matrix; per-project images layer on top of `.openlock/Containerfile`. New commands: `openlock update-base` (re-point the `FROM` line to the current base hash, sentinel-guarded), `openlock prune-images [--legacy]` (remove stale sandbox/base image tags; `--legacy` also clears pre-v0.9.0 `openlock-core*` images), and `openlock --print-base-tag`.
- **Prebuilt base image on ghcr.** Release tags now build and push a multi-arch (amd64 + arm64) `ghcr.io/vessux/openlock-base:<hash>`; fresh installs pull it instead of running the slow local apt/node/uv build. Local build stays the offline / air-gapped fallback and produces an identically-tagged image.
- **Onboarding documentation.** Tracked `docs/` walking the install → doctor → init → validate → sandbox golden path, plus a harness-agnostic `docs/agent-config-reference.md` and `llms.txt`, drift-guarded against the live config schema.

### Changed

- **`.openlock/` is now complete-or-error.** `sandbox` no longer lazily scaffolds or restores a missing/incomplete `.openlock/`; it errors with a "run openlock init" hint instead. Run `openlock init` once per project up front.
- **`doctor` is actionable and install-safe.** Each check carries a `fix` hint shown under failures, command detection uses `Bun.which` (fixing a Fedora false-negative), and a non-interactive mode skips the runtime wizard so `curl | sh` installs are safe — `install.sh` now runs `openlock doctor` at the end.
- **Cached dev-mode gateway builds.** In fork-source dev mode, the `cargo build --release` output is cached by a fork-tree fingerprint under `~/.cache/openlock/dev-bin/`, turning a ~190 s cold build into a ~74 ms cache hit on later sessions. `OPENLOCK_REBUILD=1` forces a rebuild; the production release-binary path is unchanged.

### Removed

- **`caps` config key.** The single base image carries Node, Python, and uv unconditionally, so per-project capability selection no longer exists — a stale `caps:` key is now rejected by `openlock validate` (previously a deprecation warning). The cap-keyed default policies (`default-{js,py,js-py}.yaml`) and `core*.Containerfile` images are gone, collapsed into a single `default.yaml` and `base.Containerfile`.
- `validate-policy` command, folded into `openlock validate`.

### Fixed

- **Sandbox harness symlinks.** Inherited `ln -sf` lines pointing harness binaries at `/usr/local/bin` were clobbering the correct npm-created symlinks under the tarball-slim Node prefix, leaving a dangling target; removed, and covered by a new live-integration smoke test.
- Restored `mkdir -p /sandbox/repo` in the base image so the bind-mount target pre-exists.
- Hardened the post-create exec integration test against an echo-proxy first-egress race (the recurring CI exit-56 flake), surfacing real `curl` errors (`-sSf`) instead of muting them.

## v0.8.0

### Added

- **Docker runtime support.** `OPENLOCK_RUNTIME=docker|podman` (or `default_runtime:` in `~/.config/openlock/config.yaml`) selects the container runtime; the first-run wizard prompts when autodetect is ambiguous. In-container controls (Landlock, seccomp, namespace/netns enforcement) are identical across runtimes — the differences are at the host trust boundary (rootful docker vs rootless podman), documented in the README threat model.

### Changed

- Bumped the openshell fork to **v0.6.0** (absorbs 36 upstream commits incl. per-sandbox auth, `SANDBOX_METHODS`, docker macOS host-gateway, L7 wildcards, Providers v2). openlock now provisions a per-sandbox gateway-minted JWT (signing bundle + `allow_unauthenticated_users`) in `ensure-gateway.ts`, required since the fork supervisor refuses to start without one.

### Removed

- **Anthropic auto-default removed (breaking).** openlock no longer silently selects the `anthropic` provider for the `claude_code` harness when credentials happen to exist. The provider must be explicit — `--provider`, `OPENLOCK_PROVIDER`, or `default_provider:` in `~/.config/openlock/config.yaml`. With no explicit selection, `sandbox` errors instead of guessing.
- Legacy `readToken()` / `writeToken()` shims removed from `src/tokens.ts`, superseded by the multi-provider `readProvider` / `writeProvider` / `hasAnyProvider` API.

### Fixed

- **Gateway lifecycle:** keep the gateway alive while any session metadata exists; non-destructive `stop` + reap with auto-start on reattach; retry `openshell sandbox create` once on early failure.

## v0.7.0

### Security

- **`openlock-hnp` — sandbox egress bypass fixed.** Pre-v0.7.0 openlock launched the harness via raw `podman exec`, landing it in the container's default netns with no `HTTPS_PROXY`, no Landlock, no `cred_inject`. Outbound HTTPS reached real upstreams directly — the sandbox wasn't actually a sandbox. Affected Mac and Linux equally; CI never caught it because the existing live tests use `openshell sandbox create -- /bin/bash -c "..."` (which goes through the supervisor and gets full enforcement), but the post-create attach path that real openlock invocations use was never exercised. Fix routes the harness via `openshell sandbox exec`, so the supervisor applies the proxy env, TLS bundle, netns enter, and Landlock seccomp. Defense-in-depth follow-up (`openlock-9nv`) tracks closing the host-side `podman exec` bypass too.

### Added

- **Provider abstraction (xoz).** `openlock login` is now a wizard that supports multiple providers. New `openrouter` provider works with the `opencode` harness. Same strip-and-replace credential protection as the existing Claude Code / Anthropic path — real key never enters the sandbox; gateway rewrites `Authorization` at HTTP egress.
- `--provider <id>` flag on `sandbox`, `login`, `logout`. Selection precedence: flag > `OPENLOCK_PROVIDER` env > `~/.config/openlock/config.yaml` `default_provider:` > error.
- `openlock providers` — list configured providers (stored / in-gateway / compatible harnesses).
- `openlock logout [--provider <id>]` — delete stored provider credentials (interactive picker when no flag).
- Global config `default_provider:` key.
- `bun run render:policies` script. Default policies (`policies/default*.yaml`) are now generated from the provider registry; CI drift test fails if committed files diverge.

### Changed

- `~/.config/openlock/credentials.json` is now multi-provider (v2 shape). Existing v1 files migrate silently on first read.
- `providers/refresh.yaml` accepts a new `source: file` kind for credentials stored in the multi-provider file. `openrouter` provider entry uses it.
- Default policies (`policies/default*.yaml`) now include an `opencode` block with both `api.anthropic.com` (x-api-key cred_inject) and `openrouter.ai` (Authorization Bearer cred_inject) endpoints. Per-binary cap-aware binaries (claude+node / claude+python3 / claude+node+python3) preserved.

### Deprecated

- For the `claude_code` harness with no provider signal AND a stored anthropic record, openlock auto-selects `anthropic` and prints a one-shot deprecation hint. The auto-default is removed in v0.8.0; users should set `--provider`, `OPENLOCK_PROVIDER`, or `default_provider:` to silence.
- Legacy `readToken()` / `writeToken()` shims in `src/tokens.ts` are removed in v0.8.0.

## v0.6.0

### Breaking

- **Mount system v2.** `.openlock/config.yaml` `mounts[]` now supports four types: `copy-once`, `copy-refresh`, `bind` (live `podman -v` passthrough), `git-bundle` (host repo bundled in + cloned in container). The workdir mount at `/sandbox/repo` is now **optional**; absence yields an empty `/sandbox/repo`. Existing configs that depend on the prior bundle-of-`projectPath` behaviour must add an explicit `git-bundle` workdir mount:
  ```yaml
  mounts:
    - source: .
      target: /sandbox/repo
      type: git-bundle
  ```
  See README "Seeds: mounts, args, env" for the full type matrix + examples.
- Fork pin bumped to [`vessux/OpenShell` v0.4.0-rc.1](https://github.com/vessux/OpenShell/releases/tag/v0.4.0-rc.1) for `--volume` + auto userns-remap on rootless podman.

### Added

- `--branch <name>` flag on `openlock sandbox`. Honoured for `git-bundle` workdir (clones with `-b <branch>`); rejected (exit 2) for `bind`/absent workdir with explanatory stderr.
- README: 6 worked examples covering workdir + non-workdir cases; security/ownership/VM-driver notes for bind.

### Fixed

- Image-level provisioning of `/sandbox/repo` so openshell's PID 1 chdir succeeds even when no workdir mount is declared (PR #30).
- `createSession` waits for openshell's async `--upload` to land in `/sandbox/.openlock/` before tearing down the staging tmp dir (race surfaced when container start got faster with the image-level mkdir).
- Bundle clone idempotency check uses `[ -d ${target}/.git ]` instead of `[ -d ${target} ]` so the image-baked empty `/sandbox/repo` doesn't suppress the first clone.

### Known limitations

- `cleanSession --copy-dir` hardcodes `/sandbox/repo` + `/sandbox/out.bundle` paths; under bind workdir it produces redundant bundle work, under no-workdir-mount it produces an empty copy. Deferred to post-v0.6.0 cleanup.
- Mac smoke matrix (Plan B Task 17 Steps 1-6) verified against PR #30 HEAD on 2026-05-21. Lima ARM64 (Steps 7-8) deferred to user.

### Mac smoke matrix results — 2026-05-21

| Step | Scenario | Result |
|---|---|---|
| 1 | git-bundle workdir → clone, commit inside, sync-back to `refs/heads/openlock/<session>` | ✅ |
| 2 | bind workdir → bidirectional edits, "Bind workdir; no sync-back needed." | ✅ |
| 3 | bind read-only sub-mount (target `/home/sandbox/logs`) → read OK, write blocked | ✅ |
| 4 | no workdir mount → empty `/sandbox/repo` provisioned by image, "No workdir mount; skipping sync-back." | ✅ |
| 5 | `--branch` rejection on bind + absent workdir → exit 2 with spec messages | ✅ |
| 6 | invalid configs (copy-* at `/sandbox/repo`, git-bundle basename collision) → parse errors | ✅ |
| 7a | Lima ARM64 --branch validators (5+6) | ✅ |
| 7b | Lima ARM64 container create (1/2/3/4) | ✅ (after Linux fixes below) |
| 8 | VM-driver bind rejection | pending (separate openshell config) |

Fixes discovered during smoke that landed in PR #30:
- Image-level `/sandbox/repo` provisioning.
- Staging-upload race wait.
- Bundle clone idempotency check (`.git` instead of dir).
- Fork pin bump v0.3.0 → v0.4.0-rc.1.
- README: bind log example moved to `/home/sandbox/logs` (avoid `/sandbox/.openlock/` upload collision).
- **Gateway `--bind-address 0.0.0.0` on Linux** — on rootless podman, containers see `host.containers.internal` as the slirp4netns/pasta gateway IP (not loopback), so the gateway must bind a non-loopback interface. Mac unaffected (podman-machine VM bridges back to host 127.0.0.1).
- **Sandbox uid 999999 in `openlock-core` images, with numeric `USER 999999:999999` directive** — picks a uid that fits both macOS podman-machine's default subuid range (100000-1099999) and Linux's typical 524288+ range. The openshell fork parses `Config.User` as numeric and applies `--userns=keep-id:uid=N,gid=N` when any bind mount is present, so the in-image sandbox uid must match for host-owned bind sources to be writable from inside the container on Linux. Without this, container→host writes failed with EACCES on rootless podman.
- **CI: live integration job** — `.github/workflows/test.yml` now runs `tests/integration/` under `OPENLOCK_LIVE_INTEGRATION=1` in a separate job after the unit-test pass. Keeps local `bun test` fast (3 integration tests still skip without the env var) while ensuring the gated tests never silently regress.
