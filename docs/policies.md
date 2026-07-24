# Policies

A sandbox's egress + trust policy lives at `.openlock/policy.yaml`, scaffolded by `openlock init` (the template is shaped by the chosen harness) and linted by `openlock validate`. The full policy schema is in the [agent config reference](./agent-config-reference.md).

The base template ships as `policies/default.yaml`. Point a run at an explicit policy file with `openlock sandbox --policy /abs/path/to/policy.yaml`.

For the enforcement model behind the schema — how the sandbox proxy orders network decisions, host-wildcard matching, L7/TLS inspection, and the policy prover that gates policy changes — see OpenShell's [security policy reference](https://github.com/vessux/OpenShell/blob/main/architecture/security-policy.md).

## What the fork adds

openlock's credential moat rests on a policy extension the OpenShell fork layers on top of the base network policy: the per-endpoint `cred_inject` block (`network_policies.<name>.endpoints[].cred_inject`).

- **Strip-and-replace, not pattern-match.** `strip_headers` drops whatever credential header the agent set, and `inject` re-adds it from a gateway-held credential (`from_credential`, optional `value_prefix` such as `"Bearer "`). The agent never holds the raw secret, and a spoofed or prompt-injected credential header is stripped before it leaves the sandbox — this defends against exfiltration *and* spoofing, not just leakage.
- **Per-binary scoping.** A `binaries: [{ path: … }]` list on the policy block, paired with `allowed_secrets`, gates the secret to a single binary. `/usr/bin/gh` can be granted `GITHUB_TOKEN` while every other binary — the agent included — is denied it, so a compromised agent cannot resolve a tool's credential.

Both are driven from `.openlock/config.yaml` `credentials:` and `.openlock/policy.yaml` `network_policies`; the example below is the end-to-end wiring.

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
