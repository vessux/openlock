FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client unzip \
    iproute2 iptables openssh-sftp-server \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Sandbox uid 999999 — see containers/core.Containerfile for rationale.
RUN groupadd -r supervisor && useradd -r -g supervisor -d /home/supervisor -s /usr/sbin/nologin supervisor \
    && groupadd -g 999999 sandbox && useradd -u 999999 -g 999999 -d /sandbox -s /bin/bash -m sandbox

RUN HOME=/root bash -c "curl -fsSL https://bun.sh/install | bash" \
    && mv /root/.bun/bin/bun /usr/local/bin/ \
    && rm -rf /root/.bun

RUN corepack enable

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
USER 999999:999999
