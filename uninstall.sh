#!/usr/bin/env bash
# openlock uninstaller.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<user>/openlock/main/uninstall.sh | bash
#   curl -fsSL .../uninstall.sh | bash -s -- --purge
#   curl -fsSL .../uninstall.sh | bash -s -- --purge --yes
#
# install.sh only drops a binary. openlock then LAZILY creates gateway state,
# sandbox containers, workspace volumes, and images that only the `openlock`
# CLI itself knows how to enumerate — so removal is not the inverse of
# installation. Teardown therefore happens THROUGH `openlock` while the
# binary still exists: deleting the binary first would strand every runtime
# resource with no tool left to clean it up. If the binary is already
# missing or broken, this script degrades to printing manual commands
# instead of failing or silently skipping that part of the cleanup.
#
# Default (no flags) is conservative: stops the gateway, then REPORTS
# everything still on disk (sessions/containers/volumes, config, credentials,
# images) along with the exact command to remove each. Nothing that could
# hold uncommitted work or a credential is touched unasked. The binary and
# its cache are removed too, but ONLY once nothing remains that needs them —
# deleting them first would print a report full of commands the user can no
# longer run. If sessions or images are still around, the binary (and cache,
# which holds the fork binaries `clean`/`prune-images` need) is kept, with an
# explicit note saying so, until a follow-up run finds nothing left.
#
#   --purge     Remove everything: config, credentials, state/sessions,
#               sandbox containers, workspace volumes, and images. Prompts
#               [y/N] first if any sessions (== workspace volumes) exist,
#               since a volume can hold uncommitted work; --yes bypasses.
#   --yes       Non-interactive; assume "yes" to the --purge confirmation.
#   --dry-run   Print what would happen; change nothing.

set -euo pipefail

PURGE=0
ASSUME_YES=0
DRY_RUN=0

for arg in "$@"; do
  case "${arg}" in
    --purge) PURGE=1 ;;
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: uninstall.sh [--purge] [--yes] [--dry-run]

  (no flags)  Stop the gateway, remove the openlock binary and its cache,
              then report what else still exists and how to remove it.
  --purge     Also remove config, credentials, state/sessions, sandbox
              containers, workspace volumes, and images.
  --yes       Non-interactive; skip the --purge confirmation prompt.
  --dry-run   Print what would happen; change nothing.
EOF
      exit 0
      ;;
    *)
      echo "uninstall: unrecognized argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

# --- Path resolution --------------------------------------------------------
#
# Every path below is built from an environment variable ($HOME,
# $XDG_CONFIG_HOME, $OPENLOCK_INSTALL_DIR). An unguarded `rm -rf
# "$VAR/subdir"` with VAR empty-but-set targets the filesystem root, not the
# intended directory — `set -u` alone does not catch a set-but-empty
# variable. `assert_safe_path` below is the single choke point every
# deletion in this script must pass through; nothing bypasses it.

HOME_DIR="${HOME:-}"
if [ -z "${HOME_DIR}" ]; then
  echo "uninstall: \$HOME is empty or unset; refusing to guess paths." >&2
  exit 1
fi
case "${HOME_DIR}" in
  /) echo "uninstall: \$HOME resolved to '/'; refusing to proceed." >&2; exit 1 ;;
  /*) ;;
  *) echo "uninstall: \$HOME ('${HOME_DIR}') is not an absolute path; refusing to proceed." >&2; exit 1 ;;
esac

# Mirrors install.sh's `${OPENLOCK_INSTALL_DIR:-${HOME}/.local/bin}` — `:-`
# falls back on unset OR empty, so a stray `OPENLOCK_INSTALL_DIR=` in the
# environment can't collapse this. This is the FIRST choice for where the
# binary lives; the openlock-usable check below falls back further to PATH
# for installs that don't live here (e.g. `bun link`), so this stays the
# common case and existing behavior for normal installs is unchanged.
INSTALL_DIR="${OPENLOCK_INSTALL_DIR:-${HOME_DIR}/.local/bin}"
OPENLOCK_BIN="${INSTALL_DIR}/openlock"

# Matches src/global-config/paths.ts and src/tokens.ts: XDG_CONFIG_HOME wins
# only when non-empty.
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CONFIG_BASE="${XDG_CONFIG_HOME}"
else
  CONFIG_BASE="${HOME_DIR}/.config"
fi
CONFIG_DIR="${CONFIG_BASE}/openlock"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
CREDENTIALS_FILE="${CONFIG_DIR}/credentials.json"

# Matches src/sandbox/ensure-gateway.ts (STATE_DIR) and
# src/sandbox/session-store.ts (sessionsDir) — not XDG_STATE_HOME-aware
# upstream, so this script isn't either.
STATE_DIR="${HOME_DIR}/.local/state/openlock"
SESSIONS_DIR="${STATE_DIR}/sessions"
GATEWAY_PID_FILE="${STATE_DIR}/gateway.pid"

# Matches src/sandbox/fork-binaries.ts, ensure-base.ts, build-supervisor-image.ts
# — not XDG_CACHE_HOME-aware upstream either.
CACHE_DIR="${HOME_DIR}/.cache/openlock"

# Single choke point for every deletion this script performs. Refuses to
# proceed on empty, non-absolute, "/", $HOME-itself, or anything that
# doesn't look like an openlock-owned path.
assert_safe_path() {
  local path="${1:-}"
  local label="${2:-path}"
  if [ -z "${path}" ]; then
    echo "uninstall: internal error — ${label} is empty; refusing to delete anything." >&2
    exit 1
  fi
  case "${path}" in
    /)
      echo "uninstall: internal error — ${label} resolved to '/'; refusing." >&2
      exit 1
      ;;
    /*) ;;
    *)
      echo "uninstall: internal error — ${label} ('${path}') is not an absolute path; refusing." >&2
      exit 1
      ;;
  esac
  if [ "${path}" = "${HOME_DIR}" ]; then
    echo "uninstall: internal error — ${label} resolved to \$HOME itself; refusing." >&2
    exit 1
  fi
  case "${path}" in
    */openlock | */openlock/*) ;;
    *)
      echo "uninstall: internal error — ${label} ('${path}') doesn't look like an openlock path; refusing." >&2
      exit 1
      ;;
  esac
}

# Removes $1 (labeled $2) after the safety check above. Honors --dry-run.
# No-op if the path doesn't exist.
safe_rm_rf() {
  local path="$1" label="$2"
  assert_safe_path "${path}" "${label}"
  if [ ! -e "${path}" ] && [ ! -L "${path}" ]; then
    return 0
  fi
  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "  would remove ${label}: ${path}"
  else
    rm -rf -- "${path}"
    echo "  removed ${label}: ${path}"
  fi
}

# --- openlock binary health check ------------------------------------------
#
# Teardown must go through openlock while it still works. If it's missing or
# broken, degrade to printed manual commands rather than failing outright.
#
# OPENLOCK_INSTALL_DIR (or its default) is checked first so a normal install
# behaves exactly as before. Only when that binary is absent or fails
# `--version` do we fall back to whatever `openlock` resolves to on PATH —
# this is what a `bun link` dev install needs, since it symlinks into
# ~/.cache/.bun/bin (or wherever bun's global bin dir is), never under
# OPENLOCK_INSTALL_DIR. Only when neither works do we degrade to the
# manual-instructions path below (openlock-ujv).
openlock_usable=0
if [ -x "${OPENLOCK_BIN}" ] && "${OPENLOCK_BIN}" --version >/dev/null 2>&1; then
  openlock_usable=1
else
  path_bin="$(command -v openlock 2>/dev/null || true)"
  if [ -n "${path_bin}" ] && "${path_bin}" --version >/dev/null 2>&1; then
    OPENLOCK_BIN="${path_bin}"
    openlock_usable=1
  fi
fi

run_openlock() {
  # Best-effort: a single subcommand failing (e.g. no runtime configured)
  # should not abort the rest of the teardown.
  if ! "${OPENLOCK_BIN}" "$@"; then
    echo "  warning: \`openlock $*\` exited non-zero; continuing." >&2
  fi
}

# List of session names found on disk (works without the binary — pure
# filesystem read of session-store.ts's on-disk layout). Every session has a
# workspace volume (session-ops.ts tears container + volume down together),
# so "a session exists" and "a volume exists" are the same fact here.
session_names=()
if [ -d "${SESSIONS_DIR}" ]; then
  for meta in "${SESSIONS_DIR}"/*/meta.json; do
    [ -e "${meta}" ] || continue
    name="$(grep -m1 '"name"' "${meta}" 2>/dev/null | sed -E 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
    if [ -n "${name}" ]; then
      session_names+=("${name}")
    else
      session_names+=("(unnamed: ${meta})")
    fi
  done
fi

# Best-effort check for leftover openlock-owned images, independent of the
# binary (works even when it's broken/missing). A plain `image list` (no
# --size/stats) is the same cheap call `openlock prune-images` itself makes —
# not the expensive per-image/container VM round trip the project avoids in
# default paths — so it's fine to run here too, unconditionally.
images_present=0
for rt in podman docker; do
  command -v "${rt}" >/dev/null 2>&1 || continue
  if "${rt}" image list --format '{{.Repository}}:{{.Tag}}' 2>/dev/null |
    grep -qE '^(ghcr\.io/vessux/openlock-base:|openlock-sandbox:|openlock/supervisor:latest$)'; then
    images_present=1
    break
  fi
done

# Shared manual-teardown guidance for when the binary can't be used to do
# this itself (missing/broken). Containers/volumes only — images get their
# own guidance where callers already know whether any were actually found
# (images_present), so it isn't duplicated here. No gateway line: both call
# sites already run stop_gateway() up front, independent of openlock_usable,
# so there's nothing left to tell the user to do about the gateway here.
print_manual_container_volume_hint() {
  echo "  Sandbox containers are named openshell-sandbox-<session-name>:"
  echo "    podman ps -a --filter name=openshell-sandbox-"
  echo "    podman rm -f <container>   # or: docker rm -f <container>"
  echo "  Inspect volumes (openlock is the only tool that maps sessions to volumes"
  echo "  precisely; reinstalling openlock to run \`openlock clean --all\` first is safer"
  echo "  than guessing):"
  echo "    podman volume ls"
}

# Shared manual-teardown guidance for images, used whenever the binary can't
# run `openlock prune-images` itself. No section header — callers print
# their own, since the two call sites want different framing.
print_manual_image_hint() {
  echo "    podman image ls | grep -E 'openlock-(sandbox|base)|openlock/supervisor'"
  echo "    podman image rm <image>   # or: docker image rm <image>"
}

# Sends SIGTERM to the process named in $GATEWAY_PID_FILE, but only after
# confirming it's alive and actually looks like an openlock gateway (its
# command line contains the openshell-gateway binary — see
# src/sandbox/fork-binaries.ts / ensure-gateway.ts). A pid can be recycled by
# the OS between the gateway writing it and this script running; killing
# whatever unrelated process now holds that pid would be worse than leaving
# a stale gateway running. This is the backstop for when the openlock binary
# is missing/broken and can't run `gateway stop` itself (openlock-ujv).
stop_gateway_via_pidfile() {
  [ -f "${GATEWAY_PID_FILE}" ] || return 0
  local pid
  pid="$(cat "${GATEWAY_PID_FILE}" 2>/dev/null || true)"
  case "${pid}" in
    '' | *[!0-9]*)
      echo "  gateway pid file (${GATEWAY_PID_FILE}) doesn't contain a valid pid — leaving it alone"
      return 0
      ;;
  esac
  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "  gateway pid file points to pid ${pid}, which isn't running (stale) — nothing to stop"
    return 0
  fi
  local cmd
  cmd="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  case "${cmd}" in
    *openshell-gateway*) ;;
    *)
      echo "  gateway pid file points to pid ${pid}, but that process doesn't look like an"
      echo "  openlock gateway (recycled pid?) — leaving it alone"
      return 0
      ;;
  esac
  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "  would stop gateway process directly via pid file (pid ${pid})"
    return 0
  fi
  kill -TERM "${pid}" 2>/dev/null || true
  # SIGTERM is asynchronous. The caller is about to rm -rf the very state
  # directory this process still owns (gateway.db, gateway.pid, gateway.log,
  # pki/) — if it flushes or reopens any of those on its way down after that
  # removal, it can recreate the directory we just deleted, leaving a
  # half-purged machine that reports success. So wait for actual exit before
  # returning, bounded since this is always a local process (openlock-ujv).
  local waited_ms=0
  local timeout_ms=3000
  local interval_s=0.15
  local interval_ms=150
  while [ "${waited_ms}" -lt "${timeout_ms}" ]; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "  stopped gateway process directly via pid file (pid ${pid})"
      return 0
    fi
    sleep "${interval_s}"
    waited_ms=$((waited_ms + interval_ms))
  done
  # Still alive 3s after SIGTERM. An uninstaller's whole job here is to
  # guarantee the state it's about to delete isn't still owned by a live
  # process, so escalate rather than print a warning and proceed anyway —
  # a SIGKILL is far cheaper than a "purge complete" that silently wasn't.
  echo "  gateway process (pid ${pid}) didn't exit within 3s of SIGTERM — sending SIGKILL"
  kill -KILL "${pid}" 2>/dev/null || true
  sleep 0.2
  if kill -0 "${pid}" 2>/dev/null; then
    echo "  warning: gateway process (pid ${pid}) is STILL running after SIGKILL — state" >&2
    echo "  removal below may leave files it still holds open. This shouldn't be possible" >&2
    echo "  for a normal process; investigate manually before trusting the purge report." >&2
  else
    echo "  stopped gateway process directly via pid file (pid ${pid}, required SIGKILL)"
  fi
}

# Stops the gateway through `openlock gateway stop` when the binary is
# usable, then ALWAYS falls through to the pid-file check too. The subcommand
# above is best-effort (run_openlock swallows a non-zero exit) and is skipped
# entirely when the binary is missing/broken, so stop_gateway_via_pidfile is
# what keeps a dead or misbehaving binary from stranding a running gateway
# process (openlock-ujv).
stop_gateway() {
  if [ "${openlock_usable}" -eq 1 ]; then
    if [ "${DRY_RUN}" -eq 1 ]; then
      echo "  would run: ${OPENLOCK_BIN} gateway stop"
    else
      run_openlock gateway stop
    fi
  fi
  stop_gateway_via_pidfile
}

# --- --purge -----------------------------------------------------------------

if [ "${PURGE}" -eq 1 ]; then
  echo "openlock uninstall --purge"
  echo

  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "Dry run — nothing will be changed."
    echo
    if [ "${#session_names[@]}" -gt 0 ]; then
      echo "Would prompt for confirmation: ${#session_names[@]} session(s) with workspace volumes found:"
      for n in "${session_names[@]}"; do echo "  - ${n}"; done
      echo
    fi
    echo "Stopping gateway..."
    stop_gateway
    if [ "${openlock_usable}" -eq 1 ]; then
      echo "Would run: ${OPENLOCK_BIN} clean --all"
      echo "Would run: ${OPENLOCK_BIN} prune-images"
      echo "Would run (best-effort): remove base + supervisor images directly (prune-images keeps the current base tag)"
    else
      echo "openlock binary not usable (checked \$OPENLOCK_INSTALL_DIR and PATH) — would print manual teardown commands instead of running them."
    fi
    if [ -e "${OPENLOCK_BIN}" ] || [ -L "${OPENLOCK_BIN}" ]; then
      echo "Would remove binary: ${OPENLOCK_BIN}"
    else
      echo "No openlock binary found to remove (checked \$OPENLOCK_INSTALL_DIR and PATH)."
    fi
    echo "Would remove config dir (config.yaml + credentials.json): ${CONFIG_DIR}"
    echo "Would remove state dir (sessions + gateway pid/log + pki): ${STATE_DIR}"
    echo "Would remove cache dir: ${CACHE_DIR}"
    exit 0
  fi

  if [ "${#session_names[@]}" -gt 0 ] && [ "${ASSUME_YES}" -ne 1 ]; then
    echo "openlock: ${#session_names[@]} session(s) still have workspace volumes that may hold"
    echo "uncommitted work:"
    for n in "${session_names[@]}"; do echo "  - ${n}"; done
    echo
    echo "--purge deletes these containers and volumes permanently. To salvage a workspace"
    echo "first, run (with the openlock binary still installed):"
    echo "  openlock clean --all --copy <dir>"
    echo
    printf 'Continue and permanently delete these session volumes? [y/N] '
    read -r answer || answer=""
    case "$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]')" in
      y|yes) ;;
      *)
        echo "Aborted — nothing was removed. Re-run with --yes to skip this prompt."
        exit 0
        ;;
    esac
    echo
  fi

  echo "Stopping gateway..."
  stop_gateway

  if [ "${openlock_usable}" -eq 1 ]; then
    echo "Tearing down sessions (containers + workspace volumes)..."
    run_openlock clean --all

    echo "Pruning stale images..."
    run_openlock prune-images

    # prune-images deliberately keeps the current base tag and never touches
    # the supervisor image (see src/sandbox/prune-images.ts categorizeImages
    # and src/sandbox/build-supervisor-image.ts) — by design, since it's meant
    # for *stale* image cleanup, not full removal. clean --all above already
    # removed every container, so nothing should be "in use" any more; sweep
    # the two remaining known tags directly, best-effort, on whichever
    # runtime(s) are present.
    for rt in podman docker; do
      command -v "${rt}" >/dev/null 2>&1 || continue
      base_tags="$("${rt}" image list --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^ghcr\.io/vessux/openlock-base:' || true)"
      if [ -n "${base_tags}" ]; then
        echo "${base_tags}" | while IFS= read -r tag; do
          [ -n "${tag}" ] || continue
          "${rt}" image rm "${tag}" >/dev/null 2>&1 || true
        done
      fi
      "${rt}" image rm "openlock/supervisor:latest" >/dev/null 2>&1 || true
    done
  else
    echo "openlock binary missing or not runnable (checked \$OPENLOCK_INSTALL_DIR and PATH) —"
    echo "cannot enumerate sessions through it. Manual cleanup needed for runtime resources"
    echo "(the gateway process itself was already handled above):"
    if [ "${#session_names[@]}" -gt 0 ]; then
      echo "  Known session names (from ${SESSIONS_DIR}):"
      for n in "${session_names[@]}"; do echo "    - ${n}"; done
    fi
    print_manual_container_volume_hint
    if [ "${images_present}" -eq 1 ]; then
      echo "  Images:"
      print_manual_image_hint
    fi
  fi

  echo
  echo "Removing local files..."
  safe_rm_rf "${OPENLOCK_BIN}" "openlock binary"
  safe_rm_rf "${CONFIG_DIR}" "config dir (config.yaml + credentials.json)"
  safe_rm_rf "${STATE_DIR}" "state dir (sessions + gateway pid/log + pki)"
  safe_rm_rf "${CACHE_DIR}" "cache dir"

  echo
  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "Dry run complete — nothing was changed."
  else
    echo "openlock purge complete."
  fi
  exit 0
fi

# --- Default (conservative) --------------------------------------------------

echo "openlock uninstall"
echo

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "Dry run — nothing will be changed."
  echo
fi

echo "Stopping gateway..."
stop_gateway

# Deleting the binary first would strand every runtime resource with no tool
# left to clean it up (the failure mode this whole script exists to avoid) —
# so only remove it here when it's either already useless (broken/missing)
# or genuinely nothing is left that needs it. Otherwise keep it (and its
# cache: it holds the downloaded fork binaries `clean`/`prune-images` need —
# see src/sandbox/fork-binaries.ts; deleting it here would force an
# unplanned re-download the moment the user runs the very command this
# report tells them to run) and say so plainly.
keep_binary=0
if [ "${openlock_usable}" -eq 1 ] &&
  { [ "${#session_names[@]}" -gt 0 ] || [ "${images_present}" -eq 1 ]; }; then
  keep_binary=1
fi

echo
if [ "${keep_binary}" -eq 1 ]; then
  reasons=()
  [ "${#session_names[@]}" -gt 0 ] && reasons+=("${#session_names[@]} session(s)")
  [ "${images_present}" -eq 1 ] && reasons+=("leftover image(s)")
  reason_str="${reasons[0]}"
  [ "${#reasons[@]}" -gt 1 ] && reason_str="${reasons[0]} and ${reasons[1]}"
  echo "Keeping the openlock binary and its cache: ${reason_str} still need it to be"
  echo "cleaned up (the commands below only work while it's installed). Run those"
  echo "commands, then re-run this script to finish — or use --purge to do it all now."
  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "  (dry run — binary and cache would be kept either way)"
  fi
else
  echo "Removing binary and cache..."
  safe_rm_rf "${OPENLOCK_BIN}" "openlock binary"
  safe_rm_rf "${CACHE_DIR}" "cache dir (regenerable — fork binaries + build contexts)"
fi

echo
# Only announce the leftovers list when there is actually something in it —
# printing the header and then "nothing found" reads like a bug, and the
# clean-uninstall case is the common one.
found_anything=0
if [ "${#session_names[@]}" -gt 0 ] || [ -f "${CONFIG_FILE}" ] || [ -f "${CREDENTIALS_FILE}" ] ||
  [ -d "${STATE_DIR}" ] || [ "${images_present}" -eq 1 ]; then
  echo "The following still exist and were left untouched:"
  echo
fi

if [ "${#session_names[@]}" -gt 0 ]; then
  found_anything=1
  echo "Sessions (sandbox containers + workspace volumes), ${#session_names[@]} found:"
  for n in "${session_names[@]}"; do echo "  - ${n}"; done
  if [ "${keep_binary}" -eq 1 ]; then
    echo "  Remove with:  openlock clean --all"
    echo "  Salvage first with:  openlock clean --all --copy <dir>"
  else
    print_manual_container_volume_hint
  fi
  echo
fi

if [ -f "${CONFIG_FILE}" ]; then
  found_anything=1
  echo "Config:  ${CONFIG_FILE}"
  echo "  Remove with:  rm -f ${CONFIG_FILE}"
  echo
fi

if [ -f "${CREDENTIALS_FILE}" ]; then
  found_anything=1
  echo "Credentials (SENSITIVE):  ${CREDENTIALS_FILE}"
  echo "  Remove with:  rm -f ${CREDENTIALS_FILE}"
  echo
fi

if [ -d "${STATE_DIR}" ]; then
  found_anything=1
  echo "State dir (sessions + gateway pid/log + pki):  ${STATE_DIR}"
  echo "  Remove with:  rm -rf ${STATE_DIR}   (after cleaning sessions above)"
  echo
fi

if [ "${images_present}" -eq 1 ]; then
  found_anything=1
  echo "Images (base, supervisor, and/or built sandbox images) found:"
  if [ "${keep_binary}" -eq 1 ]; then
    echo "  Remove stale ones with:  openlock prune-images   (run after \`openlock clean --all\`"
    echo "  so nothing is still \"in use\")"
    echo "  prune-images intentionally keeps the current base tag and never touches the"
    echo "  supervisor image; remove those directly once nothing references them:"
    echo "    podman image rm \$(podman image list --format '{{.Repository}}:{{.Tag}}' | grep '^ghcr\\.io/vessux/openlock-base:')"
    echo "    podman image rm openlock/supervisor:latest"
  else
    print_manual_image_hint
  fi
  echo
fi

if [ "${found_anything}" -eq 0 ]; then
  echo "Nothing else found — openlock has been fully removed."
else
  echo "Or run this script again with --purge to remove all of the above automatically"
  echo "(--purge will ask before deleting any session with a workspace volume)."
fi
