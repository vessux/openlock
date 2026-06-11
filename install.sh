#!/usr/bin/env bash
# openlock installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<user>/openlock/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/<user>/openlock/main/install.sh | OPENLOCK_VERSION=v0.1.0 bash
#
# Drops the openlock binary into ~/.local/bin (or $OPENLOCK_INSTALL_DIR
# if set). The fork binaries (openshell-gateway, openshell-sandbox,
# openshell CLI) are fetched lazily by openlock itself on first run.

set -euo pipefail

OPENLOCK_REPO="${OPENLOCK_REPO:-vessux/openlock}"
OPENLOCK_VERSION="${OPENLOCK_VERSION:-latest}"
INSTALL_DIR="${OPENLOCK_INSTALL_DIR:-${HOME}/.local/bin}"

uname_os=$(uname -s)
uname_arch=$(uname -m)

case "${uname_os}" in
  Darwin) os="apple-darwin" ;;
  Linux)  os="unknown-linux-gnu" ;;
  *)      echo "Unsupported OS: ${uname_os}" >&2; exit 1 ;;
esac

case "${uname_arch}" in
  arm64|aarch64) arch="aarch64" ;;
  x86_64|amd64)  arch="x86_64" ;;
  *) echo "Unsupported arch: ${uname_arch}" >&2; exit 1 ;;
esac

if [ "${os}" = "apple-darwin" ] && [ "${arch}" = "x86_64" ]; then
  echo "Intel Mac is not currently supported." >&2
  exit 1
fi

triple="${arch}-${os}"
asset="openlock-${triple}.tar.gz"

if [ "${OPENLOCK_VERSION}" = "latest" ]; then
  release_url="https://api.github.com/repos/${OPENLOCK_REPO}/releases/latest"
  OPENLOCK_VERSION="$(curl -fsSL "${release_url}" | grep -oE '"tag_name"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  if [ -z "${OPENLOCK_VERSION}" ]; then
    echo "Could not resolve latest release tag." >&2
    exit 1
  fi
fi

download_url="https://github.com/${OPENLOCK_REPO}/releases/download/${OPENLOCK_VERSION}/${asset}"

echo "Installing openlock ${OPENLOCK_VERSION} (${triple}) to ${INSTALL_DIR}"

mkdir -p "${INSTALL_DIR}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

curl -fsSL -o "${tmpdir}/${asset}" "${download_url}"
tar -xzf "${tmpdir}/${asset}" -C "${tmpdir}"
mv "${tmpdir}/openlock" "${INSTALL_DIR}/openlock"
chmod 0755 "${INSTALL_DIR}/openlock"

echo "Installed: ${INSTALL_DIR}/openlock"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Note: ${INSTALL_DIR} is not in your PATH." ;;
esac

echo
echo "Checking prerequisites..."
"${INSTALL_DIR}/openlock" doctor || true
