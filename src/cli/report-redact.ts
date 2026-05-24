import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";

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

// Provider-specific patterns sourced from each plugin (more specific — applied first).
const PROVIDER_PATTERNS: Pattern[] = PROVIDER_IDS.flatMap((id) =>
  PROVIDERS[id].redactionPatterns().map((re) => ({
    kind: id,
    re,
    replace: `[REDACTED:${id}]`,
  })),
);

// Generic security patterns that apply regardless of provider (applied after provider patterns).
const GENERIC_PATTERNS: Pattern[] = [
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

// Order: provider-specific FIRST (more specific), generic AFTER (catch-all).
const PATTERNS: Pattern[] = [...PROVIDER_PATTERNS, ...GENERIC_PATTERNS];

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
