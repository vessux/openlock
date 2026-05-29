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
 && case "$ARCH" in \
      x64)   NODE_SHA256=22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f ;; \
      arm64) NODE_SHA256=8cfd5a8b9afae5a2e0bd86b0148ca31d2589c0ea669c2d0b11c132e35d90ed68 ;; \
      *)     echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz -o /tmp/node.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
 && rm /tmp/node.tar.xz \
 && corepack enable

RUN ARCH=$(uname -m) \
 && case "$ARCH" in \
      x86_64)  UV_SHA256=14411de26cdea5f5139fafaf2b675b1c633e744dd49c6d6a9fc8817ec065158b ;; \
      aarch64) UV_SHA256=055c329c38a93c01d378349d51cb4d521d1998c8a79355ddc00f863ce451942f ;; \
      *)       echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${ARCH}-unknown-linux-gnu.tar.gz -o /tmp/uv.tar.gz \
 && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
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
