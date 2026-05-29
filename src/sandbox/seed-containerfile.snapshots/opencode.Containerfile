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
ARG SANDBOX_UID=999999
ARG SANDBOX_GID=999999

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
RUN npm install -g opencode-ai@1.15.5
USER ${SANDBOX_UID}:${SANDBOX_GID}
