#!/usr/bin/env python3
"""Wire proof against local echo server — inspect actual upstream headers."""
import urllib.request, json, ssl, os, sys

ECHO_HOST = os.environ.get("ECHO_HOST", "192.168.127.1")
ECHO_PORT = os.environ.get("ECHO_PORT", "9443")
BASE_URL = f"https://{ECHO_HOST}:{ECHO_PORT}"

# Trust the echo server's CA cert if available
ctx = ssl.create_default_context()
ca_path = "/tmp/echo-ca.pem"
if os.path.exists(ca_path):
    ctx.load_verify_locations(ca_path)
    print(f"Loaded CA cert from {ca_path}")
else:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    print(f"WARNING: No CA cert at {ca_path}, disabling TLS verification")

api_key = os.environ.get("ANTHROPIC_API_KEY", "NOT SET")
print(f"ANTHROPIC_API_KEY in env: {api_key}")
print()

# Test 1: Send request with smuggled auth headers
print("=" * 60)
print("TEST: Agent sends fake auth headers")
print("Expected: cred_inject strips them, injects provider key")
print("=" * 60)

data = json.dumps({"test": "wire-proof", "message": "hello"}).encode()
req = urllib.request.Request(f"{BASE_URL}/v1/messages", data=data)
req.add_header("Content-Type", "application/json")
req.add_header("x-api-key", "agent-smuggled-fake-key")
req.add_header("Authorization", "Bearer agent-smuggled-token")
req.add_header("Cookie", "session=agent-smuggled-cookie")
req.add_header("anthropic-version", "2023-06-01")

print(f"Sending to: {BASE_URL}/v1/messages")
print(f"  x-api-key: agent-smuggled-fake-key")
print(f"  Authorization: Bearer agent-smuggled-token")
print(f"  Cookie: session=agent-smuggled-cookie")
print()

try:
    resp = urllib.request.urlopen(req, context=ctx)
    body = json.loads(resp.read().decode())
    headers = body.get("headers", {})

    print("RECEIVED BY ECHO SERVER:")
    for name, value in sorted(headers.items()):
        prefix = ">>>" if name.lower() in ("x-api-key", "authorization", "cookie") else "   "
        print(f"  {prefix} {name}: {value}")

    print()
    print("VERDICT:")
    has_smuggled_key = headers.get("x-api-key", "") == "agent-smuggled-fake-key"
    has_smuggled_auth = "agent-smuggled-token" in headers.get("authorization", "")
    has_smuggled_cookie = "agent-smuggled-cookie" in headers.get("cookie", "")
    has_provider_key = "agent-smuggled" not in headers.get("x-api-key", "")

    if has_smuggled_key:
        print("  FAIL: x-api-key still contains agent's smuggled key")
    elif has_provider_key and headers.get("x-api-key"):
        print(f"  PASS: x-api-key was replaced with provider key: {headers['x-api-key'][:20]}...")
    else:
        print(f"  INFO: x-api-key = {headers.get('x-api-key', 'MISSING')}")

    if has_smuggled_auth:
        print("  FAIL: Authorization still contains agent's smuggled token")
    elif "authorization" not in {k.lower() for k in headers}:
        print("  PASS: Authorization header was stripped")
    else:
        print(f"  INFO: Authorization = {headers.get('authorization', headers.get('Authorization', 'MISSING'))}")

    if has_smuggled_cookie:
        print("  FAIL: Cookie still contains agent's smuggled session")
    elif "cookie" not in {k.lower() for k in headers}:
        print("  PASS: Cookie header was stripped")
    else:
        print(f"  INFO: Cookie = {headers.get('cookie', headers.get('Cookie', 'MISSING'))}")

except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()}")
    sys.exit(1)
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
