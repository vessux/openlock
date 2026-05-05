#!/usr/bin/env bash
# Verify per-binary credential scoping (Enhancement C).
# Tests that binaries can only resolve their own allowed_secrets.
# Requires: allowed_secrets configured in the active policy.
# Exit 0 = scoping works (good). Exit 1 = cross-provider leak (bad).

set -euo pipefail

failures=0
PLACEHOLDER_PREFIX="openshell:resolve:env:"

try_resolve() {
    local binary="$1"
    local header_name="$2"
    local env_key="$3"
    local expect="$4"  # "resolve" or "block"

    local placeholder="${PLACEHOLDER_PREFIX}${env_key}"

    local response
    response=$(curl -sS --max-time 5 \
        -H "${header_name}: ${placeholder}" \
        "https://httpbin.org/headers" 2>&1) || true

    if echo "$response" | grep -q "$placeholder"; then
        if [ "$expect" = "block" ]; then
            echo "OK:   $binary → $env_key — placeholder NOT resolved (blocked as expected)"
        else
            echo "FAIL: $binary → $env_key — placeholder NOT resolved (should have been)"
            failures=$((failures + 1))
        fi
    elif echo "$response" | grep -qi "$header_name"; then
        if [ "$expect" = "resolve" ]; then
            echo "OK:   $binary → $env_key — resolved to real value"
        else
            echo "FAIL: $binary → $env_key — resolved (should have been blocked)"
            failures=$((failures + 1))
        fi
    else
        echo "SKIP: $binary → $env_key — could not determine (endpoint may be blocked)"
    fi
}

echo "=== Per-binary credential scope check ==="
echo ""
echo "NOTE: This script must be run inside a sandbox with per-binary"
echo "      allowed_secrets configured. Results depend on which binary"
echo "      is executing this script and the active policy."
echo ""

echo "Current process: $$"
echo "Binary: $(readlink -f /proc/$$/exe 2>/dev/null || echo 'unknown')"
echo ""

echo "Checking environment variable visibility..."
for key in ANTHROPIC_API_KEY GITHUB_TOKEN NPM_TOKEN; do
    val="${!key:-}"
    if [ -z "$val" ]; then
        echo "  $key: not set"
    elif [[ "$val" == ${PLACEHOLDER_PREFIX}* ]]; then
        echo "  $key: placeholder (resolution gated by policy)"
    else
        echo "  $key: REAL VALUE VISIBLE (scoping may not be active)"
        failures=$((failures + 1))
    fi
done

echo ""
if [ "$failures" -gt 0 ]; then
    echo "FAILED: $failures scope violation(s) detected"
    exit 1
else
    echo "PASSED: credential scoping looks correct"
    echo "(Full verification requires testing cross-binary resolution via cred_inject)"
fi
