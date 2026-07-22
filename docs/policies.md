# Policies

A sandbox's egress + trust policy lives at `.openlock/policy.yaml`, scaffolded by `openlock init` (the template is shaped by the chosen harness) and linted by `openlock validate`. The full policy schema is in the [agent config reference](./agent-config-reference.md).

The base template ships as `policies/default.yaml`. Point a run at an explicit policy file with `openlock sandbox --policy /abs/path/to/policy.yaml`.

## Injecting a secondary credential (e.g. GITHUB_TOKEN)

To let the sandboxed agent call a third-party API with a token that stays in the
gateway (never enters the sandbox), declare the credential in `config.yaml` and
scope its injection in `policy.yaml`.

`.openlock/config.yaml`:

    credentials:
      - name: github
        values:
          GITHUB_TOKEN: { from_env: GITHUB_TOKEN }

`.openlock/policy.yaml` — scope the token to only the binary that should use it:

    network_policies:
      github:
        binaries: [{ path: /usr/bin/gh }]
        allowed_secrets: [GITHUB_TOKEN]
        endpoints:
          - host: api.github.com
            port: 443
            protocol: rest
            rules: [{ allow: { method: GET, path: /** } }]
            cred_inject:
              strip_headers: [Authorization]
              inject:
                - header: Authorization
                  from_credential: GITHUB_TOKEN
                  value_prefix: "Bearer "

Then export the token and run:

    export GITHUB_TOKEN=ghp_...
    openlock sandbox ./your-repo

The gateway injects `Authorization: Bearer <token>` into requests to
`api.github.com` from `/usr/bin/gh` only — every other binary is denied the
secret (per-binary scoping). If the env var is unset at run-time, `openlock
sandbox` errors before creating the sandbox.

**Caveat:** providers are attached to a sandbox only when its session is first
created. If you add a new `credentials:` entry to a project that already has a
running session, re-running `openlock sandbox` re-provisions the credential in
the gateway but does not attach the new provider to that existing sandbox —
recreate the session (`openlock clean <name>` then `openlock sandbox`) so the
new provider gets attached.
