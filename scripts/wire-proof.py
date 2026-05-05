#!/usr/bin/env python3
"""Wire proof: send request with fake auth headers through cred_inject proxy."""
import urllib.request, json, ssl, os

ctx = ssl.create_default_context()
data = json.dumps({"model": "claude-sonnet-4-20250514", "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}).encode()
req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=data)
req.add_header("Content-Type", "application/json")
req.add_header("x-api-key", "agent-smuggled-fake-key")
req.add_header("Authorization", "Bearer agent-smuggled-token")
req.add_header("anthropic-version", "2023-06-01")

print(f"ANTHROPIC_API_KEY in env: {os.environ.get('ANTHROPIC_API_KEY', 'NOT SET')}")
print(f"Sending x-api-key: agent-smuggled-fake-key")
print(f"Sending Authorization: Bearer agent-smuggled-token")
print("---")

try:
    resp = urllib.request.urlopen(req, context=ctx)
    print(f"HTTP {resp.status}: {resp.read().decode()}")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()}")
except Exception as e:
    print(f"Error: {e}")
