# .openlock/Containerfile — your sandbox image. Edit freely.
#
# Default: pull the openlock-maintained base image (fast, content-hashed).
# To customize the base, comment out the FROM + the two ARGs below, then
# uncomment EVERYTHING in the inline reference block (including its ARGs).
# Source: github.com/vessux/openlock/containers/base.Containerfile
#
FROM ghcr.io/vessux/openlock-base:abc123def456

# Sandbox uid/gid — must match the base image's user. The openshell fork
# parses Config.User from the image and applies userns mapping; keep numeric.
ARG SANDBOX_UID=60000
ARG SANDBOX_GID=60000

# ---- Base image (inline reference) ----------------------------------------
# Build the base locally instead of pulling: comment out FROM + ARGs above,
# uncomment everything below.
#
# FROM ubuntu:24.04
# RUN echo base
#

# ---- Harness ---------------------------------------------------------------
# Add/remove harness installs below. Keep the final USER directive.
USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.128
RUN npm install -g opencode-ai@1.15.5
RUN chown -R ${SANDBOX_UID}:${SANDBOX_GID} /sandbox
USER ${SANDBOX_UID}:${SANDBOX_GID}
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
