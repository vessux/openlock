# Mounts, args & env

> `.openlock/config.yaml` reference. See also the [agent config reference](./agent-config-reference.md) for the complete machine-readable schema.

`.openlock/config.yaml` accepts three optional fields that let you inject host content into the sandbox and tweak the agent launch:

- `mounts[]` — entries that wire host paths into the container. Each entry requires `source` (host path, absolute / `~/...` / relative-to-project-root), `target` (absolute container path), and `type` (one of `copy-once`, `copy-refresh`, `bind`, `git-bundle`). Optional `readOnly: true` is valid on `bind` only.
- `args[]` — extra argv appended to the in-container agent launch (today: `claude`).
- `env{}` — extra environment variables set on the agent process.

### Mount types

| type | semantics | target |
|---|---|---|
| `copy-once` | stage once at create | under `/sandbox/.openlock/` (not `/sandbox/repo`) |
| `copy-refresh` | re-stage on every attach | under `/sandbox/.openlock/` (not `/sandbox/repo`) |
| `bind` | live `podman -v` passthrough | anywhere; `readOnly: true` supported |
| `git-bundle` | host repo bundled at create, cloned in container | anywhere outside `/sandbox/.openlock/` |

The container path `/sandbox/repo` is the **workdir**: agent launch + sync-back hardcode `-w /sandbox/repo`. The workdir mount is optional; if present, its `type` must be `bind` or `git-bundle`. If absent, openlock provisions an empty `/sandbox/repo` so existing exec helpers don't fail. Reserved names under `/sandbox/.openlock/`: `.gitconfig`, `bundles`.

#### Example — git-bundle workdir (default / typical)

```yaml
mounts:
  - source: .
    target: /sandbox/repo
    type: git-bundle
```

Host repo is bundled at session create + cloned to `/sandbox/repo`. Commits sync back via `refs/sandbox/<session>/*` on session exit. `--branch <name>` honoured at clone time.

#### Example — bind workdir (live editor sync)

```yaml
mounts:
  - source: .
    target: /sandbox/repo
    type: bind
```

Host directory mounted live. No bundle, no clone, no sync-back — edits propagate both ways immediately.

#### Example — bind host cache for cross-session reuse

```yaml
mounts:
  - source: ~/.cache/uv
    target: /home/sandbox/.cache/uv
    type: bind
```

#### Example — read-only bind for log tailing

```yaml
mounts:
  - source: ./logs
    target: /home/sandbox/logs
    type: bind
    readOnly: true
```

Note: avoid binding under `/sandbox/.openlock/` — that prefix is openlock's `--upload` destination and a bind there collides with the staging upload.

#### Example — no workdir mount (in-container clone / scratch)

```yaml
mounts: []
```

`/sandbox/repo` is provisioned empty + owned by `sandbox:sandbox`. Agent or user populates via `git clone` or any other means.

#### Example — multi-repo git-bundle (workdir + extras)

```yaml
mounts:
  - source: .
    target: /sandbox/repo
    type: git-bundle
  - source: ../shared-lib
    target: /sandbox/shared-lib
    type: git-bundle
```

Each git-bundle source basename must be unique. Sync-back applies to the workdir bundle only; non-workdir bundles are snapshot-at-create.

#### Example — Claude Code with seed-skills plugin (copy-refresh)

```yaml
mounts:
  - source: ~/.cache/seed-skills/bundles/abc123
    target: /sandbox/.openlock/skills
    type: copy-refresh
args: ["--plugin-dir", "/sandbox/.openlock/skills"]
```

### Notes

**Security (bind).** Bind mounts grant the container live access to host files. Container-side compromise reaches host. You decide the exposure surface.

**Ownership (Linux bind).** On rootless podman, the openshell fork auto-applies `--userns=keep-id:uid=N,gid=N` (sandbox uid from the image's `USER` directive) whenever any `--volume` is set, so bind files are bidirectionally editable across host ↔ container without manual prep. On rootless docker, ownership depends on daemon-wide `userns-remap`; for cross-uid bind on docker, prefer copy-* mounts. On Mac the virtiofs layer handles this transparently.

**Sandbox uid in `openlock-core` images: 999999 (diverges from upstream).** The openshell fork's [`COMMUNITY_SANDBOX_UID`](https://github.com/vessux/OpenShell/blob/main/crates/openshell-driver-podman/src/client.rs) is `1_000_660_000` — high enough to avoid host-uid collisions when no userns remapping is active. The fork uses that value only as a fallback when `Config.User` is non-numeric; the actual uid for the `--userns=keep-id:uid=N` call comes from each image's `USER` directive, parsed as `u32`. **Our `openlock-core` images pin uid `999999` with `USER 999999:999999`** because `1_000_660_000` falls outside macOS podman-machine's default subuid range (`100000-1099999`) and breaks `openlock update-images` on Mac with `crun: setgroups: Invalid argument`. `999999` fits both Mac (1..1_000_000) and Linux (`524288+` typical) ranges. The fork handles per-image uids cleanly, so `openlock-core` (999999), upstream community images (1_000_660_000), and BYOC images with their own uid all coexist — the only caveat is that host-side scripts hardcoding `1_000_660_000` (chown, manual cleanup) will not target `openlock-core` containers. If you ship a BYOC image, declare a numeric `USER <uid>:<gid>` and the fork will pick it up automatically.

**VM driver.** Bind mounts are NOT supported when openshell uses its VM driver. The driver rejects bind mounts at sandbox create.

**Symlinks (copy-*).** Symlinks in `mounts[].source` are dereferenced at copy time, so producers that compile to host-symlinked caches (e.g., seed-skills) materialize as real files inside the container.

**Validation.** Openlock does not cross-validate `target` paths against references in `args[]` / `env{}`.
