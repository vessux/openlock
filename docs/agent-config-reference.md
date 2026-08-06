# openlock agent config reference

Audience: an AI agent configuring openlock in a user's project. This is the complete, machine-readable reference for `.openlock/` — schema, internals, and a decision procedure. Harness-agnostic.

## `.openlock/config.yaml` (manifest)

Top-level keys (exactly these; unknown keys are rejected): `harness`, `mounts`, `args`, `env`, `credentials`, `cpu`, `memory`.

A gitignored sibling `config.local.yaml` (same keys, all optional) overlays this
file: `harness`, `cpu`, `memory`, and unknown keys — local wins; `env` — per-key merge; `mounts` /
`args` / `credentials` — appended (base then local). It is merged before
validation, so the effective config is what gets checked.

- `mounts[]` — each entry: `source`, `target`, `type`, optional `readOnly` (valid on `type: bind` only).
  - `type` is one of: `copy-once`, `copy-refresh`, `bind`, `git-bundle`.
  - `copy-once` / `copy-refresh` targets must be under `/sandbox/.openlock/`.
- `args[]` — extra argv appended to the in-container agent launch. Common use: the harness's own permission-bypass flag — e.g. Claude Code's `--dangerously-skip-permissions` — since the sandbox (not the harness's in-process prompts) is the security boundary. See the worked example in [Mounts, args & env](./mounts.md) and [Security & runtime](./security.md).
- `env{}` — extra environment variables on the agent process.
- `credentials[]` — secondary tool-credentials injected at egress (e.g. a GitHub PAT for `api.github.com`). Each entry: `name` (the gateway provider name attached to the sandbox) and `values` (a mapping of credential-env-key → source). Two source forms, exactly one required per value: `{ from_env: VAR }` — the value is read from the host environment at `openlock sandbox` time, never committed and never enters the sandbox env; and `{ literal: VALUE }` — the value is the literal string, written directly into `config.yaml`, for non-secret values (an `anthropic-beta`/`anthropic-version`/`user-agent` version string) that don't need a host env var. Both forms are provisioned into the gateway the same way and injected per `policy.yaml` `cred_inject`; `literal` is not a separate mechanism, just a second way to supply the value — never put an actual secret behind it, since it ends up committed. The gateway provider type is always `generic`. Pair each entry with a `cred_inject` + `allowed_secrets` block in `policy.yaml` (see below); `openlock validate` errors if a `cred_inject.from_credential` is not supplied by a declared `credentials:` entry (or the primary provider).
- `cpu` — CPU limit forwarded verbatim to `openshell sandbox create --cpu` (e.g. `"2"`, `"500m"`, `"0.5"`). Omitted: openlock passes no `--cpu` at all, so the sandbox inherits openshell's own default rather than a value openlock invents.
- `memory` — memory limit forwarded verbatim to `openshell sandbox create --memory` (e.g. `"4Gi"`, `"512Mi"`, `"8G"`). Omitted: same inherit-openshell's-default behavior as `cpu`.

(There is no `caps` field — it is a rejected legacy key.)

## `.openlock/policy.yaml`

Top-level keys: `version` (required, integer) plus optional `filesystem_policy`, `landlock`, `process`, `network_policies`.

- `network_policies` — a **mapping** keyed by policy-name (NOT an array). Each value is a block with `endpoints`, `binaries`, `allowed_secrets` (an optional `name` field is accepted, but the policy name is normally the mapping key). For example:

      network_policies:
        claude_code:
          binaries: [{ path: /usr/local/bin/claude }]
          endpoints: [{ host: api.anthropic.com, port: 443 }]

  - endpoint keys: `host`, `port`, `ports`, `protocol`, `tls`, `enforcement`, `access`, `rules`, `allowed_ips`, `deny_rules`, `allow_encoded_slash`, `cred_inject`, `echo`, `trust_check`.
  - L7 rule: `allow` with matchers `method`, `path`, `command`, `query`; `deny_rules` use the same matchers. The query matcher key is `any`.
  - `cred_inject`: `provider`, `strip_headers`, `inject` (each inject entry has `header`, `from_credential`, and an optional `value_prefix` — a literal string such as `"Bearer "` prepended to the resolved credential when composing the header).
  - `trust_check`: `registry`.
  - binary entry: `path` (string). A deprecated `harness` boolean is also accepted on a binary entry — legacy, unrelated to the top-level harness enum below; real policies omit it.
- `filesystem_policy`: `include_workdir`, `read_only`, `read_write`.
- `landlock`: `compatibility`.
- `process`: `run_as_user`, `run_as_group`.

## Harnesses

Supported `harness` values: `claude_code`, `opencode`, `pi`. The harness shapes the generated `policy.yaml` and `Containerfile`. `pi` (installed binary: `pi`, package `@earendil-works/pi-coding-agent`) is OpenRouter-only — its `compatibleHarnesses` does not include `anthropic`.

## Internals (why / how)

- **gateway** — strips outbound credentials and re-injects them per policy (`cred_inject`), so the agent never holds raw API keys.
- **cred-inject** — strip-and-replace, scoped per binary; defends against both credential exfiltration and prompt-injection spoofing.
- **netns / transparent proxy** — egress flows through the supervisor's `HTTPS_PROXY`; a direct `podman exec` bypasses it.
- **sync-back** — `git-bundle` workdir commits return to the host under `refs/sandbox/<session>/*` on session exit.

See [Security & runtime](./security.md) for the human-facing depth and [Mounts, args & env](./mounts.md) for config examples.

## Decision procedure: {harness, provider, project files} → config

1. **Inspect `.openlock/`** for `config.yaml`, `policy.yaml`, `Containerfile`: none present → scaffold all (`openlock init`); some present → gap-fill the missing ones; all present → leave alone (use `--force` to regenerate).
2. **Workdir mount type:** default `bind` (live; host edits <-> sandbox). Choose `git-bundle` for an isolated snapshot (required for `--branch` and sync-back).
3. **Harness:** pick `claude_code`, `opencode`, or `pi`; it determines the generated policy + Containerfile.
4. **Provider:** explicit only — never inferred. Source it from an explicit flag/env/config/manifest; if none is given, error rather than guess.
5. **Extra mounts:** `copy-once` / `copy-refresh` (target under `/sandbox/.openlock/`), `bind` (anywhere; `readOnly` allowed), or `git-bundle`.

Prefer running `openlock init` (interactive) then `openlock validate` over hand-writing config.
