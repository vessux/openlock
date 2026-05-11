import { describe, expect, it } from "bun:test";
import { capLines, redactSecrets, stripSecretFields } from "./report-redact";

describe("capLines", () => {
  it("returns the input unchanged when total lines <= n", () => {
    const text = "a\nb\nc";
    expect(capLines(text, 10)).toBe(text);
  });

  it("keeps only the last n lines when over the cap", () => {
    const text = "a\nb\nc\nd\ne";
    expect(capLines(text, 2)).toBe("d\ne");
  });

  it("preserves a trailing newline when present", () => {
    const text = "a\nb\nc\n";
    expect(capLines(text, 2)).toBe("b\nc\n");
  });

  it("uses 5000 as the default cap", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5500; i++) lines.push(`line${i}`);
    const out = capLines(lines.join("\n"));
    expect(out.split("\n").length).toBe(5000);
    expect(out.startsWith("line500\n")).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("redacts anthropic API keys", () => {
    const { text, counts } = redactSecrets(
      "key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890 done",
    );
    expect(text).toContain("[REDACTED:anthropicKey]");
    expect(text).not.toContain("sk-ant-api03");
    expect(counts.anthropicKey).toBe(1);
  });

  it("redacts oauth tokens before the generic anthropic pattern", () => {
    const { text, counts } = redactSecrets("tok=sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(text).toContain("[REDACTED:oauthToken]");
    expect(counts.oauthToken).toBe(1);
    expect(counts.anthropicKey ?? 0).toBe(0);
  });

  it("redacts Bearer tokens (case-insensitive)", () => {
    const { text, counts } = redactSecrets("header bearer abcdefghijklmnopqrstuvwx");
    expect(text).toContain("[REDACTED:bearer]");
    expect(counts.bearer).toBe(1);
  });

  it("redacts Authorization headers including the credential value", () => {
    const { text, counts } = redactSecrets("Authorization: Basic dXNlcjpwYXNz\nnext line");
    expect(text).toContain("Authorization: [REDACTED:authHeader]");
    expect(text).not.toContain("dXNlcjpwYXNz");
    expect(text).toContain("next line");
    expect(counts.authHeader).toBe(1);
  });

  it("redacts AWS access key IDs", () => {
    const { text, counts } = redactSecrets("AKIAIOSFODNN7EXAMPLE leaked");
    expect(text).toContain("[REDACTED:awsKey]");
    expect(counts.awsKey).toBe(1);
  });

  it("redacts x-api-key headers including the value", () => {
    const { text, counts } = redactSecrets("x-api-key: shhh-this-is-private");
    expect(text).toContain("x-api-key: [REDACTED:xApiKey]");
    expect(text).not.toContain("shhh-this-is-private");
    expect(counts.xApiKey).toBe(1);
  });

  it("leaves non-secret text untouched and returns empty counts", () => {
    const { text, counts } = redactSecrets("hello world\nnothing to see");
    expect(text).toBe("hello world\nnothing to see");
    expect(counts).toEqual({});
  });
});

describe("stripSecretFields", () => {
  it("replaces known secret-named keys with [REDACTED]", () => {
    const out = stripSecretFields({
      name: "alice",
      token: "sk-ant-...",
      apiKey: "anything",
    }) as Record<string, unknown>;
    expect(out.name).toBe("alice");
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
  });

  it("matches secret keys case-insensitively", () => {
    const out = stripSecretFields({ Token: "x", API_KEY: "y" }) as Record<string, unknown>;
    expect(out.Token).toBe("[REDACTED]");
    expect(out.API_KEY).toBe("[REDACTED]");
  });

  it("recurses into nested objects", () => {
    const out = stripSecretFields({
      outer: { credentials: "leak", okay: "kept" },
    }) as { outer: Record<string, unknown> };
    expect(out.outer.credentials).toBe("[REDACTED]");
    expect(out.outer.okay).toBe("kept");
  });

  it("recurses into arrays of objects", () => {
    const out = stripSecretFields({
      list: [
        { secret: "1", keep: "yes" },
        { secret: "2", keep: "no" },
      ],
    }) as { list: Array<Record<string, unknown>> };
    expect(out.list[0].secret).toBe("[REDACTED]");
    expect(out.list[1].secret).toBe("[REDACTED]");
    expect(out.list[0].keep).toBe("yes");
  });

  it("does not mutate the input", () => {
    const input = { token: "leak", name: "alice" };
    stripSecretFields(input);
    expect(input.token).toBe("leak");
  });
});
