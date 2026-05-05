#!/usr/bin/env bash
# Verify the sandbox environment has credential placeholders, not real values.
# The supervisor replaces real tokens with openshell:resolve:env:* sentinels.
# Exit 0 = clean (good). Exit 1 = real credentials visible (bad).

set -euo pipefail

failures=0
PLACEHOLDER_PREFIX="openshell:resolve:env:"

check_env_var() {
    local key="$1"
    local val="${!key:-}"
    if [ -z "$val" ]; then
        echo "SKIP: $key — not set"
        return
    fi
    if [[ "$val" == ${PLACEHOLDER_PREFIX}* ]]; then
        echo "OK:   $key — has placeholder sentinel"
    else
        echo "FAIL: $key — contains a real value (not a placeholder)"
        failures=$((failures + 1))
    fi
}

echo "=== Credential leak check ==="
echo ""

check_env_var "ANTHROPIC_API_KEY"
check_env_var "GITHUB_TOKEN"
check_env_var "NPM_TOKEN"
check_env_var "OPENAI_API_KEY"

echo ""
echo "Scanning full environment for credential-shaped values..."
suspicious=$(env | grep -iE '(token|key|secret|password|api)=' | grep -v "${PLACEHOLDER_PREFIX}" | grep -v '^PATH=' || true)
if [ -n "$suspicious" ]; then
    echo "FAIL: suspicious env vars found:"
    echo "$suspicious"
    failures=$((failures + 1))
else
    echo "OK:   no suspicious credential-shaped env vars"
fi

echo ""
echo "Checking ~/.claude/ for credential files..."
if [ -d "$HOME/.claude" ]; then
    cred_files=$(find "$HOME/.claude" -name '*.json' -o -name 'credentials*' -o -name 'auth*' 2>/dev/null || true)
    if [ -n "$cred_files" ]; then
        echo "WARN: credential-shaped files found in ~/.claude/:"
        echo "$cred_files"
    else
        echo "OK:   ~/.claude/ has no credential files"
    fi
else
    echo "OK:   ~/.claude/ does not exist"
fi

echo ""
if [ "$failures" -gt 0 ]; then
    echo "FAILED: $failures credential leak(s) detected"
    exit 1
else
    echo "PASSED: no credential leakage"
fi
