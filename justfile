# openlock dev tasks.
#
# Delegates to the openshell-fork's mise tasks with friction workarounds baked in.
# Run `just` (or `just --list`) to see all recipes.

set shell        := ["bash", "-euc"]
set positional-arguments

fork  := justfile_directory() + "/openshell-fork"
cache := justfile_directory() + "/.cache"

# Release source for pre-built openshell-vm binary.
vm_release_repo := env_var_or_default("OPENLOCK_VM_REPO", "NVIDIA/OpenShell")
vm_release_tag  := env_var_or_default("OPENLOCK_VM_TAG", "vm-dev")

# Platform detection.
platform_os   := os()
platform_arch := arch()

vm_asset_triple := if platform_os == "macos" {
    platform_arch + "-apple-darwin"
} else {
    platform_arch + "-unknown-linux-gnu"
}

# Mise inside the fork auto-detects podman over docker; force docker explicitly.
export CONTAINER_ENGINE := "docker"

# z3 system headers/libs (macOS only — homebrew paths).
# The fork's scripts/bin/openshell wrapper falls back to bundled-z3 if missing.
export BINDGEN_EXTRA_CLANG_ARGS := if platform_os == "macos" { "-I/opt/homebrew/include" } else { "" }
export LIBRARY_PATH := if platform_os == "macos" {
    "/opt/homebrew/lib:" + env_var_or_default("LIBRARY_PATH", "")
} else {
    env_var_or_default("LIBRARY_PATH", "")
}

# Default: print recipes.
default:
    @just --list

# ──────────────────────────────────────────────────────────────────────────
# Setup (zero-start on a new machine)
# ──────────────────────────────────────────────────────────────────────────

# Full setup from scratch: check prereqs, clone fork, download pre-built VM, build CLI.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    errors=0
    warnings=0

    ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
    warn() { printf '  \033[33m!\033[0m %s\n' "$1"; warnings=$((warnings + 1)); }
    fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; errors=$((errors + 1)); }

    echo "Checking prerequisites..."
    echo ""

    # ── Hard requirements ──────────────────────────────────────────────
    if command -v mise >/dev/null 2>&1; then
        ok "mise $(mise --version 2>/dev/null | head -1)"
    else
        fail "mise not found — install: https://mise.jdx.dev/getting-started.html"
    fi

    if command -v gh >/dev/null 2>&1; then
        ok "gh $(gh --version 2>/dev/null | head -1 | awk '{print $NF}')"
    else
        fail "gh CLI not found — install: https://cli.github.com/"
    fi

    if [[ "{{platform_os}}" == "macos" ]]; then
        if command -v codesign >/dev/null 2>&1; then
            ok "codesign (Xcode CLT)"
        else
            fail "codesign not found — run: xcode-select --install"
        fi
    fi

    if [[ "{{platform_os}}" == "linux" ]]; then
        if [[ -w /dev/kvm ]] 2>/dev/null; then
            ok "/dev/kvm accessible"
        elif [[ -e /dev/kvm ]]; then
            fail "/dev/kvm exists but not writable — add your user to the kvm group"
        else
            fail "/dev/kvm not found — enable KVM in your kernel/BIOS"
        fi
    fi

    # ── Soft requirements ──────────────────────────────────────────────
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        ok "docker (only needed if you rebuild the rootfs from scratch)"
    else
        warn "docker not available — you won't be able to rebuild the rootfs, but pre-built binaries work fine"
    fi

    if [[ "{{platform_os}}" == "macos" ]]; then
        z3_path="/opt/homebrew/opt/z3"
    else
        z3_path=""
        command -v pkg-config >/dev/null 2>&1 && pkg-config --exists z3 2>/dev/null && z3_path="system"
    fi
    if [[ -n "$z3_path" ]] && { [[ "$z3_path" == "system" ]] || [[ -f "$z3_path/include/z3.h" ]]; }; then
        ok "z3 headers"
    else
        warn "z3 not found — CLI build will fall back to bundled-z3 (adds ~5 min to first build)"
        if [[ "{{platform_os}}" == "macos" ]]; then
            echo "       install with: brew install z3"
        else
            echo "       install with: apt install libz3-dev  (or equivalent)"
        fi
        echo ""
        if [[ "$errors" -eq 0 ]]; then
            read -rp "  Continue without z3? [Y/n] " answer
            if [[ "${answer:-y}" =~ ^[Nn] ]]; then
                echo "Aborted. Install z3 and re-run just setup."
                exit 1
            fi
        fi
    fi

    echo ""

    if [[ "$errors" -gt 0 ]]; then
        echo "Found $errors hard prerequisite(s) missing. Fix them and re-run just setup."
        exit 1
    fi

    # ── Clone fork ─────────────────────────────────────────────────────
    if [[ -d "{{fork}}/.git" ]]; then
        ok "openshell-fork already cloned"
    else
        echo "Cloning vessux/OpenShell into openshell-fork/..."
        gh repo clone vessux/OpenShell "{{fork}}"
        git -C "{{fork}}" remote add upstream https://github.com/NVIDIA/OpenShell.git
        git -C "{{fork}}" fetch upstream
        ok "openshell-fork cloned with upstream remote"
    fi

    # ── Download pre-built openshell-vm ────────────────────────────────
    vm_bin="{{fork}}/target/debug/openshell-vm"
    asset="openshell-vm-{{vm_asset_triple}}.tar.gz"
    if [[ -x "$vm_bin" ]]; then
        ok "openshell-vm binary exists"
    else
        echo "Downloading pre-built openshell-vm from {{vm_release_repo}} @ {{vm_release_tag}}..."
        mkdir -p "{{fork}}/target/debug"
        gh release download "{{vm_release_tag}}" \
            --repo "{{vm_release_repo}}" \
            --pattern "$asset" \
            --dir "{{cache}}"
        tar -xzf "{{cache}}/$asset" -C "{{fork}}/target/debug/"
        rm -f "{{cache}}/$asset"
        ok "openshell-vm downloaded"
    fi

    # ── Codesign (macOS only) ──────────────────────────────────────────
    if [[ "{{platform_os}}" == "macos" ]]; then
        echo "Codesigning openshell-vm with Hypervisor.framework entitlement..."
        codesign --entitlements "{{fork}}/crates/openshell-vm/entitlements.plist" \
            --force -s - "$vm_bin"
        ok "openshell-vm codesigned"
    fi

    # ── Download VM runtime (libkrun, gvproxy) ─────────────────────────
    echo "Downloading VM runtime..."
    cd "{{fork}}" && mise run vm:setup
    ok "VM runtime ready"

    # ── mise install (Rust toolchain, etc.) ────────────────────────────
    echo "Installing mise tools (re-runs once if sccache bootstrap fails)..."
    cd "{{fork}}" && (mise install || mise install)
    ok "mise tools installed"

    # ── Build openshell CLI ────────────────────────────────────────────
    echo "Building openshell CLI..."
    cd "{{fork}}" && mise exec -- openshell --version >/dev/null
    ok "openshell CLI ready: $(cd "{{fork}}" && mise exec -- openshell --version 2>/dev/null || echo 'built')"

    echo ""
    echo "Setup complete. Try:"
    echo "  just vm       # start the gateway"
    echo "  just status   # check gateway health"

# ──────────────────────────────────────────────────────────────────────────
# Build / maintenance
# ──────────────────────────────────────────────────────────────────────────

# Re-run mise install + vm:setup (use after git pull on the fork).
bootstrap:
    cd {{fork}} && (mise install || mise install)
    cd {{fork}} && mise run vm:setup

# Build openshell-vm from source + openshell CLI (needs Docker for rootfs).
build:
    cd {{fork}} && mise run vm:build
    cd {{fork}} && mise exec -- openshell --version >/dev/null

# Cross-compile the sandbox supervisor for the VM guest. No Docker needed.
# After this, `just vm-stop && just vm` picks up the new binary automatically.
rebuild-supervisor:
    cd {{fork}} && mise exec -- cargo zigbuild \
        --target aarch64-unknown-linux-gnu \
        --release \
        -p openshell-sandbox

# Lint the fork (warnings are errors). Run before committing fork changes.
lint:
    cd {{fork}} && cargo clippy -p openshell-sandbox -p openshell-cli --all-targets -- -D warnings

# Wipe VM artifacts (rootfs, runtime bundle, builds).
clean:
    cd {{fork}} && mise run vm:clean

# ──────────────────────────────────────────────────────────────────────────
# Gateway VM lifecycle
# ──────────────────────────────────────────────────────────────────────────

# Run the openshell-vm gateway in foreground (Ctrl-C to stop).
vm:
    cd {{fork}} && mise exec -- bash tasks/scripts/vm/run-vm.sh

# Build gateway + VM driver from source and run natively (no Docker image needed).
# Uses our fork's code directly — all custom policy fields (cred_inject, allowed_secrets) work.
gateway-vm:
    cd {{fork}} && mise run gateway:vm

# Run the gateway in the background; pid in .cache/vm.pid, logs in .cache/vm.log.
vm-bg:
    @mkdir -p {{cache}}
    @if [[ -f {{cache}}/vm.pid ]] && kill -0 "$(cat {{cache}}/vm.pid)" 2>/dev/null; then \
        echo "openshell-vm already running (pid $(cat {{cache}}/vm.pid))"; exit 0; \
    fi
    cd {{fork}} && nohup mise exec -- bash tasks/scripts/vm/run-vm.sh \
        >{{cache}}/vm.log 2>&1 & \
        echo $! >{{cache}}/vm.pid
    @echo "openshell-vm pid: $(cat {{cache}}/vm.pid)  log: {{cache}}/vm.log"

# Stop a backgrounded gateway (no-op if nothing running).
vm-stop:
    @if [[ -f {{cache}}/vm.pid ]]; then \
        pid=$(cat {{cache}}/vm.pid); \
        kill -0 "$pid" 2>/dev/null && kill "$pid" || true; \
        rm -f {{cache}}/vm.pid; \
    fi
    @pkill -f 'target/debug/openshell-vm( |$)' 2>/dev/null || true
    @echo "openshell-vm stopped"

# Print gateway + sandbox status.
status:
    #!/usr/bin/env bash
    set -euo pipefail
    alive=false
    if [[ -f {{cache}}/vm.pid ]] && kill -0 "$(cat {{cache}}/vm.pid)" 2>/dev/null; then
        echo "vm.pid: alive ($(cat {{cache}}/vm.pid))"
        alive=true
    else
        echo "vm.pid: not running"
    fi
    pgrep -fl 'target/debug/openshell-vm( |$)' || echo "openshell-vm process: not running"
    if $alive; then
        cd {{fork}} && mise exec -- openshell sandbox list 2>&1 | head -20 || true
    fi

# ──────────────────────────────────────────────────────────────────────────
# Sandboxes
# ──────────────────────────────────────────────────────────────────────────

# Create-or-reconnect to the persistent "dev" sandbox (claude provider if available).
sandbox-shell:
    cd {{fork}} && mise run sandbox

# Create a sandbox using a custom policy YAML (path is openlock-relative).
sandbox-with-policy POLICY:
    cd {{fork}} && mise exec -- openshell sandbox create \
        --name "policy-$(date +%s)" \
        --policy "{{justfile_directory()}}/{{POLICY}}" \
        --tty -- /bin/bash

# Run SCRIPT inside an ephemeral sandbox (with optional providers), capture output.
# Usage: just probe scripts/egress-baseline.sh
#        just probe scripts/cred-leak-check.sh anthropic
#        just probe scripts/foo.sh anthropic github
probe SCRIPT *PROVIDERS:
    @test -f "{{SCRIPT}}" || { echo "probe script not found: {{SCRIPT}}" >&2; exit 1; }
    cd {{fork}} && \
    name="probe-$(date +%s)-$$"; \
    provider_flags=""; \
    for p in {{PROVIDERS}}; do provider_flags="$provider_flags --provider $p"; done; \
    script_b64=$(base64 < "{{justfile_directory()}}/{{SCRIPT}}" | tr -d '\n'); \
    mise exec -- openshell sandbox create --name "$name" $provider_flags --no-keep -- \
        /bin/bash -c "echo $script_b64 | base64 -d | /bin/bash"

# ──────────────────────────────────────────────────────────────────────────
# Providers
# ──────────────────────────────────────────────────────────────────────────

# Create a provider. Usage: just provider-create anthropic claude ANTHROPIC_API_KEY=sk-...
provider-create NAME TYPE *CREDS:
    cd {{fork}} && \
    cred_flags=""; \
    for c in {{CREDS}}; do cred_flags="$cred_flags --credential $c"; done; \
    mise exec -- openshell provider create --name {{NAME}} --type {{TYPE}} $cred_flags

# List configured providers.
provider-list:
    cd {{fork}} && mise exec -- openshell provider list

# ──────────────────────────────────────────────────────────────────────────
# Passthroughs
# ──────────────────────────────────────────────────────────────────────────

# Passthrough to the openshell CLI.
cli *ARGS:
    cd {{fork}} && mise exec -- openshell {{ARGS}}

# Passthrough to mise inside the fork.
mise-fork *ARGS:
    cd {{fork}} && mise run {{ARGS}}

# Validate one or more policy YAML files against the sandbox schema.
validate-policy *FILES:
    bun run src/cli.ts validate-policy {{FILES}}

# Validate all policies in the policies/ directory.
validate-all-policies:
    bun run src/cli.ts validate-policy policies/*.yaml

# Start the credential refresh companion service.
cred-refresh *ARGS:
    bun run src/cli.ts cred-refresh {{ARGS}}

# Start the HTTPS echo server for wire proof testing (logs all request headers).
echo-server:
    bun run src/cli.ts echo-server

# ──────────────────────────────────────────────────────────────────────────
# openlock CLI
# ──────────────────────────────────────────────────────────────────────────

# Create a sandbox from a project directory.
sandbox PATH *ARGS:
    bun run src/cli.ts sandbox {{PATH}} {{ARGS}}

# Authenticate with Claude (setup token).
login:
    bun run src/cli.ts login

# Check prerequisites.
doctor:
    bun run src/cli.ts doctor

# Start the gateway in the background.
gateway-start:
    bun run src/cli.ts gateway start

# Stop the gateway.
gateway-stop:
    bun run src/cli.ts gateway stop

# Check gateway status.
gateway-status:
    bun run src/cli.ts gateway status
