FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client unzip \
    iproute2 iptables openssh-sftp-server \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.128 \
    && ln -sf /usr/bin/claude /usr/local/bin/claude

RUN groupadd -r supervisor && useradd -r -g supervisor -d /home/supervisor -s /usr/sbin/nologin supervisor \
    && groupadd -r sandbox && useradd -r -g sandbox -d /sandbox -s /bin/bash -m sandbox

RUN HOME=/root bash -c "curl -fsSL https://bun.sh/install | bash" \
    && mv /root/.bun/bin/bun /usr/local/bin/ \
    && rm -rf /root/.bun

RUN corepack enable

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN HOME=/root bash -c "curl -LsSf https://astral.sh/uv/install.sh | sh" \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/

USER sandbox
WORKDIR /sandbox

ENV HOME=/sandbox
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

RUN git config --global user.name "Sandbox" \
 && git config --global user.email "sandbox@openlock.local"
