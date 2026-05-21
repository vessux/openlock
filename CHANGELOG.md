# Changelog

## v0.6.0 (unreleased)

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
| 7b | Lima ARM64 container create (1/2/4) | ❌ local env (fork v0.3.0 also fails; not mount-v2) |
| 8 | VM-driver bind rejection | pending (separate openshell config) |

Fixes discovered during smoke that landed in PR #30:
- Image-level `/sandbox/repo` provisioning.
- Staging-upload race wait.
- Bundle clone idempotency check (`.git` instead of dir).
- Fork pin bump v0.3.0 → v0.4.0-rc.1.
- README: bind log example moved to `/home/sandbox/logs` (avoid `/sandbox/.openlock/` upload collision).
