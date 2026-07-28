# Changelog

## v0.11.1

Bugfix release on top of v0.11.0 (fork pin v0.8.1 → v0.8.2). Fixes a release-blocking credential-refresh regression introduced by the v0.8.0 fork sync, plus four post-release bugs affecting sandboxed Claude Code startup and gateway credential recovery.

### Fixed

- **Credential refresh died after upgrading to v0.11.0 (openlock-bb2).** The pinned fork's migration backfilled the `workspace` DB column but not the `workspace` field inside the stored protobuf payload, so after upgrading, no pre-existing provider row could be written again. The gateway could not persist a refreshed token, and because Claude OAuth tokens live about an hour, every upgrading user hit total auth failure within the hour — surfacing as a mid-session `401 Invalid bearer token` while every status surface still looked healthy. Fork pin moves to `v0.8.2`. The fix backfills the field on read rather than through a corrective migration, so it also **repairs a gateway that is already wedged** — a migration could not have, since the original migration is recorded as applied and never re-runs, and every affected user is by definition already past it. **Users on v0.11.0 should upgrade.**
- **Sandboxed Claude Code could not start on stock defaults (openlock-z08).** The default policy was missing two unconditional CC startup probes (`GET api.anthropic.com/api/hello`, `GET platform.claude.com/v1/oauth/hello`); the second host carries its own `cred_inject`, since `cred_inject` is per-endpoint and never inherited.
- **Sandboxed Claude Code showed a login selector despite valid credentials (openlock-bp2).** The onboarding file was staged at `$HOME` while `CLAUDE_CONFIG_DIR` pointed elsewhere, so CC ran first-run onboarding it could not complete inside a sandbox.
- **An expired gateway credential now fails loudly instead of silently (openlock-7mh).** A sandbox would previously start with zero credentials while the RPC reported success; on the reporter's machine this went unnoticed for five weeks. `openlock providers` now reports real credential health (`live`/`expired`, `refresh=ok`/`error`) instead of mere presence.
- **A wedged gateway provider can now be repaired (openlock-stj).** Never-clobber previously had no failure-path escape, so `openlock login` could not replace an expired, unrenewable gateway credential. It is now re-pushed when the credential is expired and its refresh worker has errored or is absent — never when the credential is live or its worker is healthy.

## v0.11.0

Feature release on top of v0.10.1 (fork pin v0.7.1 → v0.8.1). Adds a user-local config override layer, config/policy drift detection on reattach, and an uninstall script; closes a silent-loss-of-L7-enforcement gap and an OAuth refresh-token argv leak.

### Security

- **`openlock sandbox` no longer silently continues when the in-container proxy has lost TLS/L7 enforcement (openlock-bj2).** The supervisor falls back to a raw byte tunnel when its ephemeral TLS CA fails to generate or write at startup. In that state a session gets no `cred_inject` strip-and-replace, no per-binary secret scoping, and no content policy for its entire lifetime — only the coarse L4 allowed-IP/SSRF check still applies. The supervisor logged a Medium OCSF event and carried on, so openlock ran the session as though the moat were intact. openlock now scans the proxy log once create/reattach/recreate converge on Ready and blocks: a confirmed "disabled" state prompts `[y/N]` on a TTY (default No) and hard-exits non-interactively, while an "unknown" state (empty log, no event, or a policy that never uses proxy mode) warns and proceeds rather than being treated as either an implicit pass or a false-positive block. Credential *confidentiality* is not breached — injection simply never runs — but the anti-spoof property and all L7 enforcement are. Upstream fixed the root cause in the fork sync below; this is the host-side detection layer for the v0.7.1 pin window.

### Added

- **`.openlock/config.local.yaml` — a user-local config override layer (openlock-enk, closes GH #78).** A gitignored `config.local.yaml` sits alongside `config.yaml` and merges on top of it at sandbox load (mounts, args, env, credentials), so machine-specific settings no longer require editing the committed manifest. `openlock init` scaffolds a `config.local.yaml.example` and the `.openlock/.gitignore` entry on every init path; `openlock validate` lints the *merged* effective config so cross-file collisions surface, and renders a gitignore advisory; `openlock report` redaction now also covers credentials declared solely in `config.local.yaml`.
- **`openlock sandbox` detects config/policy drift on reattach and offers a rebuild (openlock-9or, GH #51).** On reattach openlock hashes the container's "cold" build inputs — Containerfile, mounts, policy content, the things that cannot be hot-applied to a running container — and compares them against what the session was built with. On drift a TTY gets a blocking `Rebuild? [y/N]` (default N); non-interactive runs warn and attach the stale container. `--rebuild` is now honoured on reattach (it previously warned and was ignored) and always forces a recreate regardless of drift.
- **`uninstall.sh`.** `install.sh` only ever dropped a binary, but openlock lazily creates gateway state, sandbox containers, workspace volumes, and images that only the `openlock` CLI itself can enumerate — so teardown runs *through* openlock while the binary still works, and degrades to printed manual commands when it is missing or broken. The default mode is conservative: it stops the gateway, removes the regenerable dev-build cache, and reports what remains (sessions, config, credentials, state, images) with the exact command to remove each, deliberately keeping the binary while sessions or images still reference it. `--purge` removes everything, with a blocking `[y/N]` whenever a session exists — a session always owns a workspace volume that may hold uncommitted work. `--yes` and `--dry-run` are also available (openlock-l51).
- **`openlock login` offers to persist the chosen provider as `default_provider` (openlock-4f7).** After a successful login, openlock asks whether to record that provider as the default so a later bare `openlock sandbox` resolves without a flag: Enter-to-accept when unset, Enter-to-decline when a different default is already set (never clobbers silently), and no prompt at all when it is already the default or the session is not a TTY. This does not relax the no-implicit-provider rule — the choice stays explicit. `openlock setup` opts out, since it already persists `default_provider` itself. Fixes the first-init GH #46 flow, where a preflight-triggered login previously left a lone `sandbox` invocation unable to resolve a provider.

### Changed

- **openshell fork synced to upstream: v0.7.1 → v0.8.1, 163 commits absorbed.** v0.8.0 is the first cut under the fork's release-line model — `main` is a never-rewritten mirror of upstream and the delta lives on `release/0.8`, re-authored from 24 historical commits into 5 changesets. Notable upstream behaviour now in effect: Stop/Start lifecycle RPCs carry a `workspace` field and podman resume looks the container up by label rather than a derived name; an endpoint may no longer set both `credential_signing` and `cred_inject`, because upstream's SigV4 signing computes over the pre-`cred_inject` request and allowing both would silently discard strip-and-replace (now rejected at policy load); and upstream's fail-closed TLS-CA hardening, which the Security entry above builds on. Upstream's workspace model also caps DNS-routable session/workspace names at 19 characters, down from 253 — the session-name budgeting fix below had to land first, since without it any project directory named longer than ~12 characters would have failed sandbox creation the moment the pin moved. v0.8.1 is a same-cycle follow-up: both the podman and docker drivers now default user bind mounts to the shared SELinux `z` relabel on SELinux-enforcing hosts such as Fedora — docker previously had no SELinux detection at all — plus a `cargo fmt` pass the v0.8.0 release gate had missed.

### Fixed

- **Session names are now budgeted against the fork's 19-character routable-name limit.** `friendlyNameFromId` built `<sanitized-dirname>-<6 hex>` with no truncation, leaving only a 12-character budget for the directory name; past that, `openlock sandbox` failed outright with `name exceeds maximum length (21 > 19)`. Most real project directory names would have broken sandbox creation the moment the fork pin moved. Truncation now strips an exposed trailing hyphen and falls back to `sandbox` when nothing printable survives. Only sandbox *creation* is affected — sessions already recorded under longer names stay fully usable for resume, `clean`, and drift-triggered rebuild.
- **Sandbox phase is read from `openshell sandbox get`'s structured JSON, not its human-formatted table (openlock-gr1).** The old parser ANSI-stripped colorized CLI output and regex-matched `Phase:\s*(\S+)` against a set of labels that included three branches which do not exist in the real `SandboxPhase` enum (`Running`, `Failed`, `Exited`) — and never matched `Error` at all. A sandbox in genuine failure phase therefore read as merely still-provisioning, surfacing only later when the CLI itself exited non-zero. It now uses `-o json` and reads the `phase` field directly, so `Error` correctly maps to "exited".
- **`openlock sandbox` no longer reports failure while a resumed sandbox's phase is catching up (openlock-weo).** After `openlock stop` followed by `openlock sandbox`, the resumed container could read as phase `Stopped` for up to ~35s after actually starting — the gateway derives phase from driver state gated on a container healthcheck, which lags — and the readiness wait treated that stale `Stopped` as death. Only the resume path, which just issued the Start itself, now tolerates a transient `Stopped` and keeps polling; a cold wait still fast-fails on `Stopped`, and the poll loop still performs a final strict check before giving up, so a genuinely dead-and-not-restarting container is never masked as a bare timeout.
- **The OAuth refresh token no longer appears on the command line during `provider refresh configure` (openlock-axb).** It was passed as `--material refresh_token=<value>`, putting a long-lived credential into argv and therefore into world-readable `/proc/<pid>/cmdline`. It now goes via `--secret-material-env refresh_token=<ENVVAR>` and the spawned process's environment, mirroring the `--credential` pattern fixed in v0.10.1. `client_id`, which is not secret, stays on `--material`. This completes the deferred half of the v0.10.1 entry — no fork change was needed, since the flag already existed upstream.
- **`openlock clean` self-heals the gateway before classifying sessions, not per-session (openlock-kx8).** A down gateway previously made `clean` fail outright with a raw `Connection refused`. Healing *before* the bulk classification pass rather than per-session is what makes this safe: `classifyAll` maps any transport error to "missing", so per-session healing would have misclassified every healthy session as missing while `--stale` targets `exited || missing` — destroying live sandboxes. If bring-up fails the bulk path now aborts before classifying, rather than acting against a gateway known to be down. With no runtime resolvable at all, teardown skips the gateway-mediated delete and reaps local bookkeeping directly, warning that a container may remain. (The underlying `getSandboxState` conflation of "gateway unreachable" with "sandbox missing" is tracked as openlock-vtl.)
- **`openlock doctor` no longer assumes `apt`, and catches a missing `cmake` in dev mode (openlock-3o7, openlock-e7q).** The install hint fell back to Debian-specific `apt install <pkg>` across all of Linux, giving wrong advice on Fedora, RHEL, and Arch; the Linux hint is now package-manager-neutral, while macOS keeps `brew install` as a safe assumption. Separately, a dev-mode gateway build now needs `cmake` (upstream's bundled z3 build invokes it) and previously died deep inside a long `cargo build` with a late, confusing error — `doctor` now checks for it up front, gated to dev mode only.
- **The gateway's generated config now sets `enable_bind_mounts` (openlock-4sh).** Upstream gates driver-config bind mounts behind an operator flag defaulting to false; without it both the podman and docker drivers hard-error on any bind mount issued through the upstream driver-config path. This is harmless today because `--volume` uses its own bespoke bind-mount path, but it unblocks migrating `--volume` onto the upstream mount system. Takes effect on the next `openlock gateway stop && start`, since the config is only rewritten when the gateway is not already running.

### Docs

- **README's "How it works" no longer describes a model that was removed (openlock-1tn, GH #50).** The pre-init capability-detection step (js/py → image + policy) no longer exists, and the gateway builds from source on first run only in dev mode, not in releases.
- **`docs/policies.md` documents the fork's `cred_inject` extension end to end (openlock-ntu, GH #50)**, against the existing `GITHUB_TOKEN` example, and links OpenShell's upstream security-policy reference.
- **New permissions-disabled recipe and rootless-podman Linux setup (GH #73, GH #49).** Covers `--dangerously-skip-permissions` inside the sandbox, and subuid/subgid setup including the widen-while-in-use footgun.
- **`docs/agent-config-reference.md`'s manifest key list now includes `harness` (openlock-c0c)**, which was missing despite being present in `MANIFEST_KEYS`.

## v0.10.1

Bugfix release on top of v0.10.0 (fork pin unchanged at v0.7.1). A post-release bug sweep of the credential, report, and sandbox-lifecycle paths.

### Added

- **`openlock sandbox --rebuild` forces a fresh image build.** The cached-image short-circuit keyed on the Containerfile hash, so a mutable third-party `FROM` tag (same Containerfile ⇒ identical hash) could never be refreshed without a manual `podman rmi`. `--rebuild` bypasses the cache (`--no-cache --pull`) to pick up the newer base; it warns and is ignored when reattaching to an existing session (image is fixed at creation).

### Fixed

- **Shell injection via `.openlock/config.yaml` mount paths (HIGH).** Mount source/target values from config were interpolated **unquoted** into the `bash -c` sandbox-setup script, so a crafted git-bundle target (e.g. `/sandbox/.openlock/x$(...)`) ran arbitrary commands at container-create time. All config-derived values are now single-quoted; a behavioral test executes the generated script and asserts no injection fires (including odd-but-legal space/colon targets).
- **Injected credentials could leak into `openlock report` bundles.** A secondary credential injected under a custom header matches no shape/header redaction regex, so its value could survive in the bundled `gateway.log`. Report generation now literal-redacts the actual known secret *values* (stored provider creds, refresh tokens, and `credentials:` bundles resolved from host env), and never throws on an unset bundle env var.
- **Credential secrets no longer appear in `/proc/<pid>/cmdline`.** Provider provisioning and cred-refresh passed `KEY=VALUE` in the spawned `openshell` argv, exposing tokens in the world-readable process command line. The secret is now handed to the child via its environment and only `--credential KEY` appears in argv. (The fork's `refresh_token` via `--material` still requires `KEY=VALUE` and is deferred — openlock-axb.)
- **`openlock sandbox --no-attach` no longer orphans the sandbox.** The gateway was spawned without its own session, so a SIGHUP when the short-lived scripted CLI exited killed the gateway too — leaving a healthy container that later `sandbox`/`clean` calls couldn't reach ("no container" / transport error). The gateway is now spawned detached (`setsid`, own session) so it survives however the CLI exits, and reattach starts the gateway *before* querying sandbox state so a dead gateway self-heals instead of masquerading as a missing container.
- **`openlock report` recorded zero sessions.** It read session state from `state.json`, but the session store writes `meta.json`; bundles always showed no sessions. It now reads `meta.json`.
- **`git-sync` no longer masks a real sync failure as "nothing to do".** A failed bundle/download drain of in-sandbox git work printed the same `No commits to sync.` as a genuinely empty repo (stderr was discarded). Stderr is now captured and genuine failures are reported distinctly.
- **`prune-images` reports only images actually removed.** It printed the full candidate list as "removed" even when `image rm` failed; it now checks each removal's exit code, lists real failures separately, and exits non-zero on failure.
- **Broadest egress patterns are now flagged.** The policy wildcard lint (`checkTldWildcard`) missed a bare `*` / `**` match-all host — the widest possible allow rule. It's now flagged, with the message generalized to "overly broad host wildcard".
- **`openlock doctor --help` prints usage** instead of running the full check suite.
- **Preflight surfaces its gateway-reachability probe.** The (already-computed, ≤15s) reachability result was discarded; it's now surfaced as a warning.
- **Uncaught async dispatch errors print cleanly.** A global `unhandledRejection` handler makes lazy `import().then(cmd)` command branches surface `openlock: <msg>` + exit 1 instead of a raw Bun stack dump. Also removed dead code: the unused `git bundle create` in `clean --copy`, the never-read `clean --json` flag, and corrected a global-config docstring that overclaimed cross-process TOCTOU safety.

## v0.10.0

### Added

- **A sandboxed `claude_code` harness can now bill your Claude subscription instead of the API.** `openlock login --provider anthropic` runs a host-side OAuth PKCE flow (hosted paste-back callback, no localhost listener) instead of `claude setup-token`, storing a real access+refresh token pair. At sandbox start the sandbox receives a dummy OAuth-shaped `.credentials.json` — flipping Claude Code into OAuth mode — while the gateway strips any `Authorization` header and re-injects the real bearer token at egress; the real token never enters the sandbox. `openlock sandbox --no-attach` supports headless import-from-CC-login flows. Breaking: a legacy v1 setup-token credential is dropped (lossy) on migration to the new credential shape — re-run `openlock login`; and `opencode` no longer supports the `anthropic` provider (subscription billing is `claude_code`-only — use `openrouter` or the OpenCode Claude-auth plugin).
- **`openlock logs <name>` surfaces the in-container proxy's egress log.** Tails the supervisor's OCSF audit log (`/var/log/openshell.<date>.log`) for per-request L7 allow/deny decisions (method, URL, policy, engine, calling binary) — visibility neither the host gateway log nor echo mode provided. `-f`/`--follow` streams, `-n`/`--lines` bounds it (default 200). An opt-in `--debug-egress` flag on `openlock sandbox` (fork v0.6.6+) raises the supervisor's log level to debug so `openlock logs` also shows L7 request/response **headers** (e.g. `anthropic-beta`, `overage-status`) — useful for confirming which billing bucket a request landed in. Off by default; applies at container creation, so reattaching keeps the session's existing log level.
- **Config-driven secondary credential injection.** A `credentials:` key in `.openlock/config.yaml` lets a sandboxed agent authenticate to third-party services (e.g. `GITHUB_TOKEN` → `api.github.com`) with the same protections as the primary provider credential: the value is read from a host env var at run time (`{ from_env: VAR }`), provisioned as a generic gateway provider, and injected at egress per-binary-scoped by `policy.yaml` — it never enters the sandbox environment or gets committed. `openlock validate` now hard-errors when a policy's `cred_inject` references a credential no attached provider supplies, or when a bundle name collides with a built-in provider. Providers attach at session-create time; adding a bundle to an existing session requires recreating it.
- **Opt-in idle-sandbox reaper (`reap_idle`, default off).** Previously, exiting `openlock sandbox` silently SIGKILLed *every* unattached-but-running sandbox across all projects after 30 minutes, with no git drain — a global side effect with no way to opt out (GH #76). Reaping is now off by default; a `reap_idle` global-config key (`off`, or a duration like `30m`/`2h`/`1d`; `OPENLOCK_REAP_IDLE_MS` env overrides) opts back in, and session-end now prints an advisory nudge listing other idle-unattached sandboxes when reaping is off, instead of touching them. When reaping is enabled: `lastAttachedAt` is now a live heartbeat (refreshed on a `min(idleMs/2, 60s)` cadence while a harness is attached) rather than a stamp frozen at attach time, so a killed CLI or dropped SSH session no longer makes an actively-used container look idle-stale; the reaper now gracefully drains in-sandbox git state (best-effort bundle sync-back) before stopping a session instead of hard-killing it; and the sessions about to be reaped are logged before the stop loop runs, not just counted afterward.

### Changed

- **openshell fork synced to upstream (fork v0.7.0, later pinned to v0.7.1): 133 commits absorbed.** The fork caught up to NVIDIA/OpenShell after a long gap (base 2026-05-26), absorbing upstream's split of the monolithic `openshell-sandbox` crate into separate `openshell-supervisor-network` (egress proxy, L7, OPA) and `openshell-supervisor-process` (landlock, netns, seccomp) crates. openlock's cred-inject + trust stack was re-homed into the network crate accordingly. No openlock CLI surface changed; sandbox creation, credential injection, and egress enforcement behave as before. Validated on macOS (podman-machine) and a native rootless-podman Linux box. v0.7.1 adds a single follow-up commit gating the gateway's `Sandbox failed to become ready` warning on the transition *into* `Error`, instead of re-firing it every 60s reconcile pass over an already-dead sandbox — the dominant driver of the unrotated `gateway.log` growth described below (GH #76).
- **Sandbox `stop` / resume now works on native Linux.** With upstream's Stop/Start RPC plumbing in place, `openlock stop <session>` followed by re-running `openlock sandbox` reliably resumes the container on native rootless podman. (A resume hang remains on the macOS podman-machine VM — tracked separately; it does not affect Linux hosts.)

### Fixed

- **The gateway builds with static-linked z3 (fork v0.7.0).** Upstream gave `openshell-server` a prover dependency that pulls `z3-sys`, so the gateway now links z3. Both the release build and openlock's dev-mode build-from-source compile it with `bundled-z3` (no runtime `libz3` dependency), matching the existing CLI build. Building the gateway from source on a fresh Linux box additionally requires `cmake` (GitHub CI runners and typical dev machines already have it).
- **`openlock init --harness <name>` choices actually stick.** The scaffolded `.openlock/config.yaml` never recorded the chosen harness, so a bare `openlock sandbox` afterward silently fell back to the hardcoded `claude_code` default and failed with a confusing `No provider selected for harness 'claude_code'` — naming the wrong harness. `init` now writes a `harness:` key, read back at sandbox launch ahead of the global `default_harness` (still overridable via `--harness` / `OPENLOCK_HARNESS`).
- **`openlock init --harness opencode` no longer scaffolds a dead OpenRouter model slug.** The commented example model had rotted (404) since free models on OpenRouter change over time; the scaffold now points at the live filtered model list instead of pinning a slug that will eventually rot again too.
- **`gateway.log` no longer grows unbounded.** The gateway's captured stdout/stderr was appended to forever across restarts — observed at 100MB (GH #76), driven mostly by the fork-side reconcile-loop warning described above. openlock now rotates the file to a single `.1` backup generation whenever it's grown past 10MB, checked at each gateway (re)start; rotation failures warn but never block startup.
- **`openlock sandbox` create/resume failures now surface their real cause (GH #75).** When a sandbox container exits during provisioning — most commonly because a host firewall/network reload flushed the netavark NAT rules a bridge-network container needs to reach the gateway — openlock used to burn its full poll timeout and report a misleading `staging upload … not visible within 30000ms`. It now fails fast with the supervisor's actual log line, falling back to a network-reachability hint when the container died before it could push any logs to the gateway. `openlock doctor` gained a reachability check that reproduces the exact container→gateway path (a throwaway container on the `openshell` network probing the gateway port): suggest-only by default (`podman network reload --all`), with a new opt-in `network_auto_reload: true` config to run the reload automatically. A related Linux-only, warn-only check now flags a gateway that came up bound to `127.0.0.1` only, since a plain readiness probe can't tell that apart from a correct wide bind. (The JWT-expiry-on-resume half of the original report turned out to already be fixed upstream — fork v0.7.1's local sandbox JWTs never expire — so no code change was needed there.)

## v0.9.2

### Fixed

- **The macOS `openshell` binary no longer needs Homebrew's z3 at runtime (fork v0.6.4).** v0.9.1 promised "works on a clean box" but only fixed Linux — the macOS aarch64 binary still dynamically linked `/opt/homebrew/opt/z3/lib/libz3.4.15.dylib`, so on a Mac without `brew install z3` it died at startup with `dyld: Library not loaded: libz3.4.15.dylib` and `openlock sandbox` failed at the provider step. The fork now static-links z3 (`bundled-z3`) on macOS too, compiled with zig as the C/C++ toolchain (GitHub's Apple-clang runners can't build the vendored z3). `otool -L` on the released binary shows only system libraries — no z3, no Homebrew — so macOS now matches Linux's clean-box guarantee.
- **Compiled `openlock sandbox` exits cleanly after the harness instead of hanging.** After the harness (e.g. opencode) exited `0`, the compiled CLI printed `Gateway kept running (N session(s) remain).` and never returned to the shell, because the detached container tether and gateway client keep the bun event loop alive and `runSandbox` only force-exited on a non-zero harness code. It now exits unconditionally with the harness's exit code; the detached session and gateway survive untouched. (`bun run` auto-exits, which masked this in dev — the same compiled-vs-interpreter footgun as v0.5.1.) This also avoids having to `^C` the hung CLI, which on a fresh box killed the auto-started gateway and wedged the container.

## v0.9.1

### Changed

- **The sandbox now works on a fresh bare-metal rootless-podman Linux box.** The in-image sandbox user UID/GID dropped from `999999` to `60000` so podman's `--userns=keep-id:uid=N` mapping fits the *stock* `/etc/subuid` range (`100000:65536`). At `999999` a fresh Ubuntu host couldn't represent the mapping, so the agent didn't own `/sandbox` and the workdir/dotfile upload failed with `tar: /sandbox: Cannot open: Permission denied` (and every subsequent `exec` too). VMs (macOS podman-machine, Lima) masked this with larger default subuid ranges. Fresh installs pull the rebuilt base image at its new content hash automatically.
- **opencode routes to OpenRouter out of the box.** `openlock init --harness opencode` now scaffolds commented `--model` / `small_model` guidance for a tool-use-capable OpenRouter model, and the opencode egress policy allows read-only `GET models.dev` so opencode can resolve models outside its bundled registry. Policy endpoints may now omit `cred_inject` for credential-free read-only hosts (cred-bearing hosts still strip-and-inject as before).
- **openshell fork binaries static-link z3 on Linux (fork v0.6.3).** The released Linux `openshell` no longer needs `libz3.so.4` at runtime, so sandbox creation works on a fresh box without installing system z3. macOS continues to link Homebrew's z3.
- **`openlock --version` now appends the build commit SHA** (e.g. `0.9.1 (a1b2c3d)`) when built in release CI, so a specific build is identifiable — including across force-moved pre-release tags. Local `bun run` still prints the bare version. The SHA is injected at compile time via `bun build --define`.

### Fixed

- **`doctor` and sandbox preflight catch an insufficient rootless subuid range.** On rootless podman (Linux, non-root), openlock now reads `/etc/subuid` and verifies the user's range covers the sandbox UID; if not, it fails legibly with a `sudo usermod --add-subuids …` fix hint up front instead of dying later at the upload with `Permission denied`. Skipped on macOS, docker, and rootful/root podman.
- **The agent owns its HOME subtree in the sandbox.** The per-project image now reclaims ownership of `/sandbox` after the root-run harness install, so the agent can write `~/.local` / `~/.config`. This fixes opencode's `unable to open database file` on a fresh sandbox, where `/sandbox/.local` had been left root-owned.
- **`doctor` no longer false-negatives when both podman and docker are installed.** The non-interactive runtime resolver only auto-picks when *exactly one* runtime is present; with both installed it returned `null`, which `doctor` rendered identically to "no runtime installed" (a misleading `✗ container runtime (podman/docker)` with an "install one" hint). `doctor` now probes both and reports **every** installed runtime plus its readiness (podman API socket / docker daemon / podman machine on macOS), so a host with both shows both. Session preflight still checks only the runtime it resolved.
- **x64 Linux binary runs on non-AVX2 CPUs.** The `openlock-x86_64-unknown-linux-gnu` release artifact is now built with Bun's `bun-linux-x64-baseline` target (x86-64-v2: SSE4.2/POPCNT, no AVX2). The previous `bun-linux-x64` build required AVX2 and crashed with `Illegal instruction (core dumped)` on older/limited CPUs the moment the binary ran (e.g. at the post-install `openlock doctor`).
- **`install.sh` usage and docs now pipe to `bash`, not `sh`.** The script's shebang and `set -euo pipefail` require Bash; the documented `| sh` invocation failed on Debian/Ubuntu (where `sh` is `dash`) with `Illegal option -o pipefail`.
- **Test suite no longer overwrites real provider credentials.** Several credential-touching suites (`login`, `logout`, `providers`, `resolve`) isolated only `HOME`, not `XDG_CONFIG_HOME`. Because `credentialsPath()` honors `XDG_CONFIG_HOME` first, running `bun test` on a machine with that variable set (common on Linux) wrote fixture data over the developer's real `~/.config/openlock/credentials.json`. These suites now neutralize `XDG_CONFIG_HOME` in setup like the already-correct ones, keeping the suite hermetic.

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
