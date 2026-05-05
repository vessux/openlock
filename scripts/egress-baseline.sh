#!/usr/bin/env bash
# Verify default-deny egress is working.
# Every request here SHOULD fail (403 from proxy or connection refused).
# Exit 0 = all blocked (good). Exit 1 = something leaked through (bad).

set -euo pipefail

failures=0

check_blocked() {
    local url="$1"
    local label="$2"
    if curl -sS --max-time 5 "$url" >/dev/null 2>&1; then
        echo "FAIL: $label — request succeeded (should be blocked)"
        failures=$((failures + 1))
    else
        echo "OK:   $label — blocked"
    fi
}

echo "=== Egress baseline check ==="
echo ""

check_blocked "https://api.github.com/zen"          "github API (not in default policy)"
check_blocked "https://www.example.com/"             "example.com (arbitrary host)"
check_blocked "https://evil.example.invalid/"        "evil.example.invalid"
check_blocked "https://httpbin.org/get"              "httpbin (arbitrary API)"
check_blocked "https://google.com/"                  "google.com"

echo ""
if [ "$failures" -gt 0 ]; then
    echo "FAILED: $failures egress leak(s) detected"
    exit 1
else
    echo "PASSED: all non-allowed hosts blocked"
fi
