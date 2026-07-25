import { describe, expect, it } from "bun:test";
import {
  decideTlsFallbackAction,
  formatTlsFallbackBlockedMessage,
  formatTlsFallbackUnknownWarning,
  scanTlsFallbackState,
} from "./tls-state";

const ENABLED_LINE =
  "2026-07-26T09:12:03.104Z OCSF CONFIG:ENABLED [INFO] TLS termination enabled: ephemeral CA generated";
const DISABLED_WRITE_LINE =
  "2026-07-26T09:12:03.104Z OCSF CONFIG:DISABLED [MED] Failed to write CA files, TLS termination disabled: Permission denied (os error 13)";
const DISABLED_GENERATE_LINE =
  "2026-07-26T09:12:03.104Z OCSF CONFIG:DISABLED [MED] Failed to generate ephemeral CA, TLS termination disabled: rcgen error";

// A representative slice of unrelated log noise: NET/HTTP traffic plus a
// DISABLED ConfigStateChange for a completely different subsystem
// (inference-route reload), which reuses the same shorthand state tag and
// must NOT be mistaken for the TLS event.
const UNRELATED_NOISE = [
  "2026-07-26T09:12:01.001Z OCSF NET:OPEN [INFO] ALLOWED node(42) -> api.anthropic.com:443",
  "2026-07-26T09:12:02.500Z OCSF CONFIG:DISABLED [MED] inference route removed [source:policy]",
  "2026-07-26T09:12:04.200Z OCSF HTTP:REQUEST [INFO] POST /v1/messages 200",
].join("\n");

describe("scanTlsFallbackState", () => {
  it("returns 'enabled' for the success ConfigStateChange line", () => {
    expect(scanTlsFallbackState(ENABLED_LINE)).toBe("enabled");
  });

  it("returns 'disabled' for the 'Failed to write CA files' failure line", () => {
    expect(scanTlsFallbackState(DISABLED_WRITE_LINE)).toBe("disabled");
  });

  it("returns 'disabled' for the 'Failed to generate ephemeral CA' failure line", () => {
    expect(scanTlsFallbackState(DISABLED_GENERATE_LINE)).toBe("disabled");
  });

  it("returns 'unknown' for an empty log", () => {
    expect(scanTlsFallbackState("")).toBe("unknown");
  });

  it("returns 'unknown' for unrelated/malformed content with no TLS event", () => {
    expect(scanTlsFallbackState(UNRELATED_NOISE)).toBe("unknown");
    expect(scanTlsFallbackState("not even a log line\n\x00garbage")).toBe("unknown");
  });

  it("is not fooled by an unrelated CONFIG:DISABLED line for a different subsystem", () => {
    const content = `${UNRELATED_NOISE}\n${ENABLED_LINE}`;
    expect(scanTlsFallbackState(content)).toBe("enabled");
  });

  it("finds the TLS event among surrounding noise", () => {
    const content = [UNRELATED_NOISE, DISABLED_WRITE_LINE, ""].join("\n");
    expect(scanTlsFallbackState(content)).toBe("disabled");
  });

  it("keeps the LAST matching verdict when both appear (disabled then enabled)", () => {
    const content = [DISABLED_WRITE_LINE, ENABLED_LINE].join("\n");
    expect(scanTlsFallbackState(content)).toBe("enabled");
  });

  it("keeps the LAST matching verdict when both appear (enabled then disabled)", () => {
    const content = [ENABLED_LINE, DISABLED_GENERATE_LINE].join("\n");
    expect(scanTlsFallbackState(content)).toBe("disabled");
  });

  it("treats a lone '(no proxy log found ...)' placeholder as unknown", () => {
    expect(scanTlsFallbackState("(no proxy log found at /var/log/openshell.*.log)\n")).toBe(
      "unknown",
    );
  });
});

describe("decideTlsFallbackAction", () => {
  it("proceeds silently when TLS termination is enabled, regardless of tty", () => {
    expect(decideTlsFallbackAction({ verdict: "enabled", interactive: true })).toBe("proceed");
    expect(decideTlsFallbackAction({ verdict: "enabled", interactive: false })).toBe("proceed");
  });

  it("warns (does not block) on an unknown verdict, regardless of tty", () => {
    expect(decideTlsFallbackAction({ verdict: "unknown", interactive: true })).toBe("warn-unknown");
    expect(decideTlsFallbackAction({ verdict: "unknown", interactive: false })).toBe(
      "warn-unknown",
    );
  });

  it("prompts on a confirmed disabled verdict in an interactive terminal", () => {
    expect(decideTlsFallbackAction({ verdict: "disabled", interactive: true })).toBe("prompt");
  });

  it("hard-blocks on a confirmed disabled verdict with no tty (deliberately NOT drift's warn-and-proceed)", () => {
    expect(decideTlsFallbackAction({ verdict: "disabled", interactive: false })).toBe("block");
  });
});

describe("formatTlsFallbackBlockedMessage", () => {
  it("names the sandbox, the cause, and the remediation", () => {
    const msg = formatTlsFallbackBlockedMessage("my-sess");
    expect(msg).toContain('"my-sess"');
    expect(msg).toContain("TLS termination DISABLED");
    expect(msg).toContain("openlock logs my-sess");
    expect(msg).toContain("openlock doctor");
    expect(msg).toContain("openlock sandbox --rebuild");
  });
});

describe("formatTlsFallbackUnknownWarning", () => {
  it("names the sandbox and points at the proxy log", () => {
    const msg = formatTlsFallbackUnknownWarning("my-sess");
    expect(msg).toContain('"my-sess"');
    expect(msg).toContain("openlock logs my-sess");
  });
});
