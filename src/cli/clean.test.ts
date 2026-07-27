import { describe, expect, it } from "bun:test";
import type { ClassifiedSession } from "../sandbox/session-ops";
import { flagSchema, runBulkClean } from "./clean";

describe("clean flagSchema", () => {
  it("declares --copy as string", () => {
    expect(flagSchema.copy).toEqual({ type: "string" });
  });

  it("declares --all and --stale as boolean", () => {
    expect(flagSchema.all).toEqual({ type: "boolean" });
    expect(flagSchema.stale).toEqual({ type: "boolean" });
  });

  it("declares --help with short -h", () => {
    expect(flagSchema.help).toEqual({ type: "boolean", short: "h" });
  });
});

function row(name: string, classification: ClassifiedSession["classification"]): ClassifiedSession {
  const meta = {
    id: name,
    name,
    repoPath: "/r",
    image: "i",
    policy: "p",
    createdAt: "2026-05-07T08:00:00Z",
    lastAttachedAt: null,
    attachedPid: null,
    harness: "claude_code" as const,
  };
  return {
    meta,
    classification,
    state: { ...meta, containerState: "running", pidAlive: false },
  };
}

describe("runBulkClean (openlock-kx8: gateway self-heal ordering)", () => {
  it("REGRESSION: self-heals the gateway BEFORE classifyAll, so a healthy running session that would only misclassify as 'missing' pre-heal is never swept by --stale", async () => {
    const calls: string[] = [];
    let gatewayUp = false;
    const exitCode = await runBulkClean(true, undefined, {
      selfHealGateway: async () => {
        calls.push("selfHeal");
        // Bring-up succeeds and the gateway is live from this point on —
        // exactly what a real startGateway() call achieves.
        gatewayUp = true;
      },
      classifyAll: async () => {
        calls.push("classifyAll");
        // classifyAll's real implementation calls getSandboxState per
        // session, which maps a gateway-down transport error to "missing"
        // (container.ts) regardless of the container's actual health. This
        // stand-in reproduces exactly that: it only reports the session's
        // true state ("attached" = healthy/running) if the gateway is
        // already up by the time classification runs. If runBulkClean ever
        // regresses to calling classifyAll before selfHeal, gatewayUp is
        // still false here and this returns "missing" instead — which is
        // precisely the bug this test guards against.
        return [row("healthy-running", gatewayUp ? "attached" : "missing")];
      },
      cleanSession: async (name) => {
        calls.push(`cleanSession:${name}`);
      },
    });
    expect(exitCode).toBe(0);
    // Correctly classified as "attached" (not stale) post-heal, so
    // cleanSession must never be invoked on it.
    expect(calls).toEqual(["selfHeal", "classifyAll"]);
  });

  it("aborts before classifyAll (and cleans nothing) when gateway self-heal fails, instead of classifying/deleting against a confirmed-dead gateway", async () => {
    const calls: string[] = [];
    const exitCode = await runBulkClean(true, undefined, {
      selfHealGateway: async () => {
        calls.push("selfHeal");
        throw new Error("Gateway did not become ready within 30s.");
      },
      classifyAll: async () => {
        calls.push("classifyAll");
        return [row("some-session", "missing")];
      },
      cleanSession: async (name) => {
        calls.push(`cleanSession:${name}`);
      },
    });
    expect(exitCode).toBe(1);
    // classifyAll/cleanSession must never run once bring-up is confirmed
    // failed — classifying against a dead gateway would misreport every
    // session as missing/stale again.
    expect(calls).toEqual(["selfHeal"]);
  });

  it("still classifies and cleans normally when self-heal succeeds (or is a no-op on a no-runtime box)", async () => {
    const calls: string[] = [];
    const exitCode = await runBulkClean(true, undefined, {
      selfHealGateway: async () => {
        calls.push("selfHeal");
      },
      classifyAll: async () => {
        calls.push("classifyAll");
        return [row("actually-stale", "missing")];
      },
      cleanSession: async (name) => {
        calls.push(`cleanSession:${name}`);
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual(["selfHeal", "classifyAll", "cleanSession:actually-stale"]);
  });

  it("a per-session cleanSession failure is caught and reported, not fatal to the batch", async () => {
    const calls: string[] = [];
    const exitCode = await runBulkClean(true, undefined, {
      selfHealGateway: async () => {},
      classifyAll: async () => [row("a", "missing"), row("b", "missing")],
      cleanSession: async (name) => {
        calls.push(name);
        if (name === "a") throw new Error("boom");
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual(["a", "b"]);
  });
});
