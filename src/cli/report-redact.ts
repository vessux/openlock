export function capLines(text: string, n: number = 5000): string {
  const hadTrailingNewline = text.endsWith("\n");
  const body = hadTrailingNewline ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (lines.length <= n) return text;
  const tail = lines.slice(lines.length - n).join("\n");
  return hadTrailingNewline ? `${tail}\n` : tail;
}

export interface RedactResult {
  text: string;
  counts: Record<string, number>;
}

interface Pattern {
  kind: string;
  re: RegExp;
  replace: string;
}

// Order matters: more specific patterns first so their counts win.
const PATTERNS: Pattern[] = [
  {
    kind: "oauthToken",
    re: /sk-ant-oat[0-9]{2}-[a-zA-Z0-9_-]{20,}/g,
    replace: "[REDACTED:oauthToken]",
  },
  {
    kind: "anthropicKey",
    re: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    replace: "[REDACTED:anthropicKey]",
  },
  {
    kind: "bearer",
    re: /Bearer\s+[a-zA-Z0-9._\-+=]{20,}/gi,
    replace: "[REDACTED:bearer]",
  },
  {
    kind: "authHeader",
    re: /Authorization:\s*[^\r\n]+/gi,
    replace: "Authorization: [REDACTED:authHeader]",
  },
  {
    kind: "awsKey",
    re: /AKIA[0-9A-Z]{16}/g,
    replace: "[REDACTED:awsKey]",
  },
  {
    kind: "xApiKey",
    re: /x-api-key:\s*[^\r\n]+/gi,
    replace: "x-api-key: [REDACTED:xApiKey]",
  },
];

export function redactSecrets(input: string): RedactResult {
  let text = input;
  const counts: Record<string, number> = {};
  for (const { kind, re, replace } of PATTERNS) {
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      counts[kind] = (counts[kind] ?? 0) + matches.length;
      text = text.replace(re, replace);
    }
  }
  return { text, counts };
}

const SECRET_KEYS = new Set(
  [
    "cred",
    "credential",
    "credentials",
    "token",
    "secret",
    "apiKey",
    "api_key",
    "accessToken",
    "refreshToken",
    "password",
  ].map((s) => s.toLowerCase()),
);

export function stripSecretFields<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(walk);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }
  return value;
}
