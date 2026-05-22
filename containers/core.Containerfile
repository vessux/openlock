FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client unzip \
    iproute2 iptables openssh-sftp-server \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Sandbox uid 1000660000 matches openshell fork's COMMUNITY_SANDBOX_UID — the
# value the fork passes to podman's `--userns=keep-id:uid=N,gid=N` when any
# bind mount is present. Aligning these uids makes host-owned bind sources
# writable from inside the container on rootless podman (Linux). On macOS the
# podman-machine VM bridges file ownership separately, so the alignment is
# harmless there.
RUN groupadd -r supervisor && useradd -r -g supervisor -d /home/supervisor -s /usr/sbin/nologin supervisor \
    && groupadd -g 1000660000 sandbox && useradd -u 1000660000 -g 1000660000 -d /sandbox -s /bin/bash -m sandbox

USER sandbox
WORKDIR /sandbox
RUN mkdir -p /sandbox/repo

ENV HOME=/sandbox
RUN git config --global user.name "Sandbox" \
 && git config --global user.email "sandbox@openlock.local"

# === Harness layers (last, for cache-on-bump) ===

# --- Claude Code ---
USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.128 \
    && ln -sf /usr/bin/claude /usr/local/bin/claude
USER sandbox
RUN cat > /sandbox/.claude.json <<'JSON'
{
  "hasCompletedOnboarding": true,
  "hasTrustDialogAccepted": true,
  "lastOnboardingVersion": "9999.99.99",
  "theme": "dark",
  "projects": {
    "/sandbox/repo": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
JSON

# --- opencode ---
USER root
RUN npm install -g opencode-ai@1.15.5 \
    && ln -sf /usr/bin/opencode /usr/local/bin/opencode
USER sandbox
