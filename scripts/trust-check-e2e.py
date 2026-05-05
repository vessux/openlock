#!/usr/bin/env python3
"""E2E test for trust_check: verify proxy denies/audits based on package vulnerability data."""

import subprocess
import sys

FETCH_SCRIPT = '''
import urllib.request, ssl, sys
ctx = ssl.create_default_context()
try:
    resp = urllib.request.urlopen(urllib.request.Request(sys.argv[1]), context=ctx, timeout=30)
    print("ALLOWED", resp.status, len(resp.read()))
except urllib.error.HTTPError as e:
    print("HTTP_ERROR", e.code, e.reason)
except urllib.error.URLError as e:
    r = str(e.reason)
    if "403" in r or "Forbidden" in r:
        print("BLOCKED", r)
    else:
        print("ERROR", r)
except Exception as e:
    print("ERROR", str(e))
'''

def fetch(url, label):
    try:
        result = subprocess.run(
            ["python3", "-c", FETCH_SCRIPT, url],
            capture_output=True, text=True, timeout=45,
        )
        out = result.stdout.strip()
        print(f"  [{label}] {out}")
        if out.startswith("ALLOWED"):
            return "allowed"
        elif out.startswith("BLOCKED"):
            return "blocked"
        elif out.startswith("HTTP_ERROR"):
            return "http_error"
        return "error"
    except Exception as e:
        print(f"  [{label}] subprocess error: {e}")
        return "error"

results = {}

# Test 1: Clean package (latest urllib3 = 2.x, no vulns) → allow
print("=== Test 1: pypi.org/simple/urllib3/ (latest, clean → allow) ===")
results["urllib3_latest"] = fetch("https://pypi.org/simple/urllib3/", "urllib3-latest")

# Test 2: Clean package (latest django = 6.x, no vulns) → allow
print("\n=== Test 2: pypi.org/simple/django/ (latest=6.0.4, clean → allow) ===")
results["django_latest"] = fetch("https://pypi.org/simple/django/", "django-latest")

# Test 3: Clean modern package → allow
print("\n=== Test 3: pypi.org/simple/typing-extensions/ (clean → allow) ===")
results["typing_ext"] = fetch("https://pypi.org/simple/typing-extensions/", "typing-ext")

# Test 4: Old urllib3 wheel (version in filename, has high vulns) → audit (allow+log)
print("\n=== Test 4: urllib3-1.24.1 wheel (high vulns → audit, allow) ===")
results["urllib3_old"] = fetch(
    "https://files.pythonhosted.org/packages/b1/53/"
    "37d82ab391393565f2f831b8f4e2c8b02e5b3b812de2fe2a6b2b3e5db72c"
    "/urllib3-1.24.1-py2.py3-none-any.whl",
    "urllib3-1.24.1",
)

# Test 5: Nonexistent package → lookup_failed → audit (fail-open, allow)
print("\n=== Test 5: nonexistent package (lookup fail → audit, allow) ===")
results["fake_pkg"] = fetch("https://pypi.org/simple/xyznonexistent99pkg/", "fake-pkg")

# Summary
print("\n=== Summary ===")
for k, v in results.items():
    print(f"  {k}: {v}")

# Expected: all allowed (trust_check only denies critical, audit is allow+log)
print("\nExpected: all 'allowed' — trust_check audit = allow with OCSF logging")
print("Check sandbox logs for TRUST_AUDIT / TRUST_LOOKUP_FAILED events")
