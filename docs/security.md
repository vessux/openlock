# Security & runtime

## Sandbox boundary

Always reach into a session via `openlock shell` / `openlock exec` — these route through the openshell supervisor, which applies `HTTPS_PROXY`, Landlock, seccomp, and netns enforcement. Direct `podman exec sandbox-<name> ...` from the host bypasses the supervisor process, but **not** its network fence: the sandbox netns installs an nftables OUTPUT rule that accepts only proxy traffic, loopback, and established connections, and rejects everything else — regardless of which process opened the socket. A host-exec'd process's direct egress attempts are rejected the same as a cooperative in-sandbox bypass. What a host-exec'd process does escape:

- **`cred_inject` and the per-binary credential gate.** Both depend on the process carrying the supervisor's proxy env (`HTTPS_PROXY` and friends); a `podman exec`'d process never inherits it, so neither applies to what it sends.
- **Non-network access.** Reading files, environment variables, or credentials already resident in the container without ever opening a socket. There's no packet, so nftables has nothing to see — by construction, not by gap.
- **Namespace injection below `podman exec`.** `nsenter`/`crun exec` straight against the container's namespaces produces no `podman exec` event either, so no host-side monitor built on `podman events` could see it — and a root host operator can do this on the first try.

The fence's own rejection log is best-effort (needs kernel `nf_log` support in the namespace) and openlock does not currently surface it on any user-facing surface — a bypass can be enforced with zero visible trail. Treat podman socket access as part of your trust boundary: anyone who has it can also stop the container, edit the supervisor, or route around detection outright.

Because the container is the safety boundary, it's fine — expected, even — to run the agent inside it with its own permission prompts turned off (e.g. Claude Code's `--dangerously-skip-permissions`, passed via `args:` in `config.yaml`; see [Agent config reference](./agent-config-reference.md) and [Mounts, args & env](./mounts.md) for the worked example). The harness's in-process approval flow isn't the control that matters here — the sandbox is.

## Container runtime choice

openlock supports **podman** (default, rootless) and **docker** as container runtimes. Select via:

- `OPENLOCK_RUNTIME=docker|podman` (per-invocation override)
- `default_runtime: docker|podman` in `~/.config/openlock/config.yaml` (persistent)
- The first-run wizard prompts when neither is set and autodetect is ambiguous.

**Idle sandbox reaping.** `reap_idle` in `~/.config/openlock/config.yaml` controls whether idle (running but unattached) sandboxes are auto-stopped at the end of an `openlock sandbox` session. It defaults to `off` — idle sandboxes are never stopped behind your back, and instead a session-end note lists them so you can `openlock stop`/`clean` them yourself. Set a duration (`30m`, `2h`, `1d`) to auto-stop sandboxes left unattached that long; `OPENLOCK_REAP_IDLE_MS` (integer ms, or `off`) overrides it per-run.

### Threat model deltas

The sandbox's in-container controls (Landlock, seccomp, namespace isolation, supervisor netns enforcement) are **identical** across runtimes. The differences live at the host trust boundary:

- **Podman, rootless (default on Linux)**: the container is spawned by an unprivileged user. A breakout still lands in your user account, not root.
- **Docker, rootful (default on most installs)**: the Docker daemon runs as root and spawns containers as root. A breakout that escapes the supervisor lands at root unless userns-remap is configured.
- **Rootless Docker** is supported but uncommon. It approximates rootless podman's host posture.
- **Mac (both runtimes)**: containers run inside a VM (Podman Machine or Docker Desktop's LinuxKit VM). The VM is the trust boundary; host exposure requires VM escape.

We recommend **rootless podman** for sensitive work. Docker is supported for compatibility with existing developer setups; use rootless docker or userns-remap if your threat model requires it.

- Secondary credentials (`credentials:` in `config.yaml`) are read from the host
  environment host-side, pushed to the gateway, and injected at egress — the same
  boundary as the primary provider credential. The token never enters the sandbox
  and is never persisted by openlock (host env is re-read on each create).
