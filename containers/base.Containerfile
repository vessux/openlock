# Source-of-truth for `ghcr.io/vessux/openlock-base:<hash>`.
# Tag = sha256(this file's content)[0..12]. CI computes the same hash and
# pushes to that exact tag. Host computes it and tries to pull before any
# local build.

FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b

ARG SANDBOX_UID=999999
ARG SANDBOX_GID=999999
ARG NODE_VERSION=22.12.0
ARG UV_VERSION=0.5.11

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client iproute2 python3 xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
 && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm /tmp/node.tar.xz \
 && corepack enable

RUN ARCH=$(uname -m) \
 && curl -fsSL https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${ARCH}-unknown-linux-gnu.tar.gz -o /tmp/uv.tar.gz \
 && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 \
    uv-${ARCH}-unknown-linux-gnu/uv uv-${ARCH}-unknown-linux-gnu/uvx \
 && rm /tmp/uv.tar.gz

RUN groupadd -r supervisor \
 && useradd -r -g supervisor -d /home/supervisor -s /usr/sbin/nologin supervisor \
 && groupadd -g ${SANDBOX_GID} sandbox \
 && useradd -u ${SANDBOX_UID} -g ${SANDBOX_GID} -d /sandbox -s /bin/bash -m sandbox

USER sandbox
WORKDIR /sandbox
ENV HOME=/sandbox
RUN git config --global user.name "Sandbox" \
 && git config --global user.email "sandbox@openlock.local"
