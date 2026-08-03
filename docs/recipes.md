# Recipes

Copy-paste `.openlock/config.yaml` / `policy.yaml` snippets, plus one longer walkthrough for a custom base image. See the [Agent config reference](./agent-config-reference.md) for the complete schema and [Mounts, args & env](./mounts.md) for the mount-type recipes (they aren't repeated here).

## CPU and memory limits

Two optional top-level `config.yaml` keys, passed through verbatim to the sandbox runtime. Omit either one and the sandbox inherits the runtime's own default — openlock does not invent a value:

```yaml
cpu: "2"        # cores — also accepts millicores, e.g. "500m", or fractional, e.g. "0.5"
memory: "4Gi"   # also accepts e.g. "512Mi", "8G"
```

## Harness pins

`.openlock/config.yaml`'s `harness:` key is written by `openlock init` and read back by `openlock sandbox`, so you don't have to pass `--harness` every time:

```yaml
harness: pi   # claude_code | opencode | pi
```

`openlock sandbox --harness <h>` overrides it for one invocation (falling back through `OPENLOCK_HARNESS`, then this file, then `default_harness:` in global config); it errors instead of switching if a session under that name already exists with a different harness, rather than silently reattaching to the wrong kind of container.

The provider is **not** part of this file — remember to pass the matching `--provider` on `openlock sandbox` (or set `OPENLOCK_PROVIDER` / `default_provider:`). See the pairing table in [Quickstart](./quickstart.md#provider-and-harness-are-paired-not-a-free-choice): `claude_code` → `anthropic`; `opencode` and `pi` → `openrouter` only.

## Harness launch args

`args:` appends to the in-container agent launch. The most common use is disabling a harness's own permission prompts — safe here because the container itself is the security boundary, not the harness's in-process approval flow (see [Security & runtime](./security.md)):

```yaml
args: ["--dangerously-skip-permissions"]   # Claude Code only
```

Other harnesses take their own flags the same way — whatever `args[]` your harness documents. For `opencode`/`pi` + OpenRouter, the flag that matters is `--model` (see the next recipe before picking one).

## Picking a model your key is allowed to use

For `opencode` or `pi` + OpenRouter: OpenRouter's public model catalog (~367 entries) lists everything regardless of what your key can actually use — most keys are restricted to a small permitted set, and picking a model outside it fails with OpenRouter's `No endpoints available matching your guardrail restrictions and data policy`, which reads like an account problem but just means "not on your key's allowlist."

```bash
openlock login --provider openrouter    # store your key first
openlock providers models openrouter
```

This prints every model your specific stored key may use, each tagged `tools=yes` or `tools=no`. A router alias (`openrouter/auto`, `openrouter/fusion`, …) is **not** automatically a safe pick — several routers report `tools=no`, and an agent harness needs tool support. Pick a `tools=yes` entry from that list, then pin it:

```yaml
args:
  - --model
  - openrouter/nvidia/nemotron-3-super-120b-a12b:free   # verify it's still in your permitted list
```

`anthropic` has no equivalent authenticated models endpoint (there's no per-key model allowlist concept for it in openlock) — `openlock providers models anthropic` errors saying so rather than returning an empty or fabricated list.

## Secondary credentials

To let the sandboxed agent call a third-party API (e.g. `gh` with a GitHub token) with a credential that stays in the gateway and never enters the sandbox, see [Policies → Injecting a secondary credential](./policies.md#injecting-a-secondary-credential-eg-github_token) for the full worked example. The short version, `.openlock/config.yaml`:

```yaml
credentials:
  - name: github
    values:
      GITHUB_TOKEN: { from_env: GITHUB_TOKEN }
```

`{ from_env: VAR }` is the **only** source form — there is no way to write a literal value directly into `config.yaml` (by design: it would get committed). The value is read from your host environment at `openlock sandbox` time.

## Egress allowlist

`.openlock/policy.yaml`'s `network_policies` is a mapping keyed by policy name, each with `binaries`, `endpoints`, and (if a credential is involved) `allowed_secrets`. `policies/default.yaml` (the generator this project's own `policy.yaml` templates are scaffolded from) already ships blocks like this one, verbatim, for package installs:

```yaml
network_policies:
  npm_packages:
    binaries:
      - path: /usr/local/bin/npm
      - path: /usr/local/bin/node
      - path: /usr/local/bin/npx
    endpoints:
      - host: registry.npmjs.org
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
        allow_encoded_slash: true
        trust_check:
          registry: npm
    allowed_secrets: []
```

To allow your own project's traffic — say, an internal API your code calls, with no credential involved — add a new block the same shape, minus `cred_inject` (only needed when a secret is being injected):

```yaml
network_policies:
  internal_api:
    binaries:
      - path: /usr/local/bin/node
    endpoints:
      - host: api.internal.example.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: /** }
    allowed_secrets: []
```

`openlock validate` lints the result; run it after any policy edit. See the [Agent config reference](./agent-config-reference.md#openlockpolicyyaml) for every accepted endpoint/rule key.

## Global config

`~/.config/openlock/config.yaml` — machine-wide defaults, a separate file with a separate 5-key schema (no manifest keys are valid here and vice versa):

| Key | Values | Default | Purpose |
|---|---|---|---|
| `default_harness` | `claude_code` \| `opencode` \| `pi` | — | Used when `--harness`/`OPENLOCK_HARNESS`/the project's own `config.yaml` don't set one. |
| `default_provider` | `anthropic` \| `openrouter` | — | Used when `--provider`/`OPENLOCK_PROVIDER` aren't set. There is no manifest-level provider key (see [Quickstart](./quickstart.md)), so this is the only way to stop passing `--provider` every time. |
| `default_runtime` | `podman` \| `docker` | — | Used when `OPENLOCK_RUNTIME` isn't set and autodetection is ambiguous. |
| `reap_idle` | `"off"` or a duration (`"30m"`, `"2h"`, `"1d"`) | `off` | Auto-stop idle (running, unattached) sandboxes after `openlock sandbox` ends a session. Off by default — nothing is stopped behind your back; `openlock reap` always runs on demand regardless. |
| `network_auto_reload` | `true` \| `false` | `false` | Opt-in: `openlock doctor` runs `podman network reload --all` automatically on detected sandbox → gateway unreachability, instead of only suggesting it. Podman/netavark-specific. |

```yaml
default_harness: pi
default_provider: openrouter
default_runtime: podman
reap_idle: 2h
network_auto_reload: false
```

`openlock setup` (interactive; requires a real terminal, not on the scripted golden path) writes this file for you one key at a time. It's also fine to hand-edit.

## Custom base image: Playwright + Chromium

There is no existing example of this in the repo — worked through here because the two ways to get it wrong are silent, not loud.

**Background.** `openlock init` scaffolds `.openlock/Containerfile` from the pinned base image (Ubuntu 24.04, pinned by digest) plus a generated harness-install block:

```dockerfile
# ---- Harness ---------------------------------------------------------------
# Add/remove harness installs below. Keep the final USER directive.
USER root
RUN npm install -g @earendil-works/pi-coding-agent@0.83.0
RUN chown -R ${SANDBOX_UID}:${SANDBOX_GID} /sandbox
USER ${SANDBOX_UID}:${SANDBOX_GID}
```

(`SANDBOX_UID`/`SANDBOX_GID` are `60000` in this project's base image — see [Mounts, args & env → Notes](./mounts.md#notes) for why. A fully custom `FROM` needs its own numeric `USER <uid>:<gid>` for the same reason: the openshell fork parses `Config.User` from the image to set up `--userns=keep-id`.)

**Trap 1 — where NOT to add your `RUN` lines.** `openlock update-base` regenerates *everything above* the `# ---- Harness ----` line (the `FROM`, the ARGs, the inline base reference) and keeps only what comes after it. A custom `RUN` placed between `FROM` and the sentinel — where an ordinary Dockerfile tutorial would put it — is **silently destroyed** the first time someone runs `update-base`. Put custom installs inside the harness block, and keep the final `USER ${SANDBOX_UID}:${SANDBOX_GID}` as the actual last line:

```dockerfile
# ---- Harness ---------------------------------------------------------------
# Add/remove harness installs below. Keep the final USER directive.
USER root
RUN npm install -g @earendil-works/pi-coding-agent@0.83.0

# Playwright + Chromium — see Trap 2 below for why this has to happen here,
# at build time, not at sandbox runtime. PLAYWRIGHT_BROWSERS_PATH matters:
# without it Chromium installs into root's own cache (~/.cache/ms-playwright,
# i.e. /root/...), which the sandbox's runtime user (uid 60000, not root)
# cannot read — the build succeeds and the agent fails at runtime with
# "Executable doesn't exist". Setting it to a path outside any user's home,
# then handing that path to uid 60000 afterward, is what Playwright's own
# official Docker image does for exactly this non-root-runtime-user case; do
# not remove this ENV line, even though nothing here looks like it needs it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright@1.62.1 \
 && playwright install --with-deps chromium \
 && chown -R ${SANDBOX_UID}:${SANDBOX_GID} /ms-playwright

RUN chown -R ${SANDBOX_UID}:${SANDBOX_GID} /sandbox
USER ${SANDBOX_UID}:${SANDBOX_GID}
```

`--with-deps` shells out to `apt-get` to install Chromium's OS-level dependencies, which needs root — fine here since this whole block still runs as `USER root`; don't move the install below the `chown`/`USER` switch. Ubuntu 24.04 (this base image) is on Playwright's officially supported list, so `--with-deps` knows how to handle it without extra flags. Pin an explicit Playwright version (checked against the registry at the time of writing; verify the current one at [playwright.dev](https://playwright.dev) before relying on it) rather than leaving it floating — the same reasoning as pinning harness versions.

**Trap 2 — build-time network is unrestricted; runtime network is not.** `podman build`/`docker build` runs host-side with full network access — no egress policy applies during a build. Once the sandbox is running, though, every outbound connection goes through the gateway's allowlist, and `playwright.dev`'s CDN (where `playwright install` fetches browser binaries from) is not in it. So:

- **Do** install Playwright + Chromium as a build step (the `RUN` above) — the download happens during `podman build`, with full network access, once, baked into the image.
- **Don't** run `npx playwright install` (or anything that downloads at agent runtime) from inside the sandbox or from `args:`/the agent's own commands — it will hit a host the policy doesn't allow, and fixing that means widening the egress policy for a one-time binary download, which is the wrong trade.

After editing, rebuild explicitly rather than waiting for drift detection to notice:

```bash
openlock sandbox --rebuild
```

(The image tag is a content hash of the whole `Containerfile`, so a plain edit does get picked up on the next create — `--rebuild` just forces it unconditionally, including on an existing session's reattach, which is the more predictable thing to reach for right after hand-editing.)

**One more footgun, unrelated to the sentinel:** `openlock init --force` regenerates *all three* `.openlock/` files (`config.yaml`, `policy.yaml`, `Containerfile`) from defaults, discarding this kind of hand edit along with everything else. Don't run `--force` on a project whose `Containerfile` you've customized.
