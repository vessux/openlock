# Source-of-truth for `ghcr.io/vessux/openlock-base:<hash>`.
# Tag = sha256(this file's content)[0..12]. CI computes the same hash and
# pushes to that exact tag. Host computes it and tries to pull before any
# local build.

FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b

ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000
ARG NODE_VERSION=22.12.0
ARG UV_VERSION=0.5.11

# nftables: required by the openshell-sandbox supervisor's per-sandbox netns
# fence (openshell-fork crates/openshell-supervisor-process/src/netns/mod.rs:
# find_nft() / install_bypass_rules()) to install the OUTPUT-chain
# ACCEPT/REJECT ruleset for the workload's network namespace. Without it
# (openlock-jsfo) the supervisor logs "nft not found; bypass detection rules
# will not be installed" and degrades to routing-only isolation: no open
# egress path, but a raw bypass attempt hangs to a TCP-level timeout instead
# of an immediate ECONNREFUSED. Empirically reproduced 2026-08-04 on
# Mac/podman: from inside the fenced workload netns (not the container's
# outer netns — `podman exec` lands in the latter), a literal-IP connect
# bypassing DNS and any proxy env hung past 8s on both :443 and a random
# high port, where the fix should produce an immediate reject.
#
# This ONLY restores fast-fail. It does NOT restore bypass *detection* (the
# dmesg-tailing monitor in bypass_monitor/mod.rs) — that path is separately
# broken by kernel.dmesg_restrict=1 + rootless podman's nested user
# namespace, which EPERMs the kernel-log read regardless of whether nftables
# is installed (confirmed empirically same day: `dmesg --follow --notime`
# fails "Operation not permitted" even as root with CAP_SYSLOG, while the
# monitor's own `dmesg --version` availability gate passes — see
# openlock-pc5e). Do not describe this change as restoring bypass
# observability.
#
# No iptables/iptables-legacy: that fallback only backs
# install_sidecar_bypass_rules() for the Kubernetes sidecar topology
# (openshell-fork crates/openshell-sandbox/src/main.rs), a deployment mode
# openlock's podman/docker driver never uses. Adding it here for "upstream
# parity" would be dead weight with nothing that exercises it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client iproute2 nftables python3 xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
 && case "$ARCH" in \
      x64)   NODE_SHA256=22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f ;; \
      arm64) NODE_SHA256=8cfd5a8b9afae5a2e0bd86b0148ca31d2589c0ea669c2d0b11c132e35d90ed68 ;; \
      *)     echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz -o /tmp/node.tar.xz \
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
 && curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${ARCH}-unknown-linux-gnu.tar.gz -o /tmp/uv.tar.gz \
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
RUN mkdir -p /sandbox/repo \
 && git config --global user.name "Sandbox" \
 && git config --global user.email "sandbox@openlock.local"
