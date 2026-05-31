# openlock agent config reference

Audience: an AI agent configuring openlock in a user's project. This is the complete, machine-readable reference for `.openlock/` — schema, internals, and a decision procedure. Harness-agnostic.

## `.openlock/config.yaml` (manifest)

Top-level keys (exactly these; unknown keys are rejected): `mounts`, `args`, `env`.

- `mounts[]` — each entry: `source`, `target`, `type`, optional `readOnly` (valid on `type: bind` only).
  - `type` is one of: `copy-once`, `copy-refresh`, `bind`, `git-bundle`.
  - `copy-once` / `copy-refresh` targets must be under `/sandbox/.openlock/`.
- `args[]` — extra argv appended to the in-container agent launch.
- `env{}` — extra environment variables on the agent process.

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
  - `cred_inject`: `provider`, `strip_headers`, `inject` (each inject entry has `header`, `from_credential`).
  - `trust_check`: `registry`.
  - binary entry: `path` (string). A deprecated `harness` boolean is also accepted on a binary entry — legacy, unrelated to the top-level harness enum below; real policies omit it.
- `filesystem_policy`: `include_workdir`, `read_only`, `read_write`.
- `landlock`: `compatibility`.
- `process`: `run_as_user`, `run_as_group`.

## Harnesses

Supported `harness` values: `claude_code`, `opencode`. The harness shapes the generated `policy.yaml` and `Containerfile`.

## Internals (why / how)

- **gateway** — strips outbound credentials and re-injects them per policy (`cred_inject`), so the agent never holds raw API keys.
- **cred-inject** — strip-and-replace, scoped per binary; defends against both credential exfiltration and prompt-injection spoofing.
- **netns / transparent proxy** — egress flows through the supervisor's `HTTPS_PROXY`; a direct `podman exec` bypasses it.
- **sync-back** — `git-bundle` workdir commits return to the host under `refs/sandbox/<session>/*` on session exit.

See [Security & runtime](./security.md) for the human-facing depth and [Mounts, args & env](./mounts.md) for config examples.

## Decision procedure: {harness, provider, project files} → config

1. **Inspect `.openlock/`** for `config.yaml`, `policy.yaml`, `Containerfile`: none present → scaffold all (`openlock init`); some present → gap-fill the missing ones; all present → leave alone (use `--force` to regenerate).
2. **Workdir mount type:** default `bind` (live; host edits <-> sandbox). Choose `git-bundle` for an isolated snapshot (required for `--branch` and sync-back).
3. **Harness:** pick `claude_code` or `opencode`; it determines the generated policy + Containerfile.
4. **Provider:** explicit only — never inferred. Source it from an explicit flag/env/config/manifest; if none is given, error rather than guess.
5. **Extra mounts:** `copy-once` / `copy-refresh` (target under `/sandbox/.openlock/`), `bind` (anywhere; `readOnly` allowed), or `git-bundle`.

Prefer running `openlock init` (interactive) then `openlock validate` over hand-writing config.
