FROM ubuntu:24.04

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
