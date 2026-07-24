import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyProcNetTcpBind,
  readGatewayRssKb,
  renderGatewayConfigToml,
  rotateLogIfLarge,
  spawnDaemonToLog,
  warnIfGatewayLoopbackOnly,
} from "./ensure-gateway";
import { pidAlive } from "./proc";

describe("renderGatewayConfigToml", () => {
  it("emits podman driver block when runtime=podman", () => {
    const out = renderGatewayConfigToml("podman", {
      supervisorImage: "img:latest",
      podmanSocket: "/run/podman/podman.sock",
    });
    expect(out).toContain("[openshell.drivers.podman]");
    expect(out).toContain('socket_path = "/run/podman/podman.sock"');
    expect(out).not.toContain("[openshell.drivers.docker]");
  });

  it("emits docker driver block when runtime=docker", () => {
    const out = renderGatewayConfigToml("docker", {
      supervisorImage: "img:latest",
    });
    expect(out).toContain("[openshell.drivers.docker]");
    expect(out).toContain("default_image =");
    expect(out).not.toContain("[openshell.drivers.podman]");
    expect(out).not.toContain("socket_path");
  });

  it("throws when podman runtime but no podmanSocket", () => {
    expect(() => renderGatewayConfigToml("podman", { supervisorImage: "x" })).toThrow(
      /podmanSocket/,
    );
  });

  it("emits sandbox-JWT issuer and unauthenticated-user escape hatch when gatewayJwt set", () => {
    const out = renderGatewayConfigToml("podman", {
      supervisorImage: "img:latest",
      podmanSocket: "/run/podman/podman.sock",
      gatewayJwt: {
        signingKeyPath: "/s/jwt/signing.pem",
        publicKeyPath: "/s/jwt/public.pem",
        kidPath: "/s/jwt/kid",
      },
    });
    expect(out).toContain("[openshell.gateway.gateway_jwt]");
    expect(out).toContain('signing_key_path = "/s/jwt/signing.pem"');
    expect(out).toContain('public_key_path = "/s/jwt/public.pem"');
    expect(out).toContain('kid_path = "/s/jwt/kid"');
    expect(out).toContain("[openshell.gateway.auth]");
    expect(out).toContain("allow_unauthenticated_users = true");
  });

  it("omits gateway_jwt and auth blocks when gatewayJwt absent", () => {
    const out = renderGatewayConfigToml("podman", {
      supervisorImage: "img:latest",
      podmanSocket: "/run/podman/podman.sock",
    });
    expect(out).not.toContain("gateway_jwt");
    expect(out).not.toContain("allow_unauthenticated_users");
  });
});

describe("classifyProcNetTcpBind (GH #75 / bd openlock-7er piece 2)", () => {
  const PORT = 18081; // hex 46A1
  const HEADER =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  // Real /proc/net/tcp[6] shape: local_address is IP:PORT in hex, little-endian
  // per octet for IPv4; state 0A = TCP_LISTEN.
  const V4_WILDCARD_LINE =
    "   0: 00000000:46A1 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";
  const V4_LOOPBACK_LINE =
    "   0: 0100007F:46A1 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";
  const V4_UNRELATED_PORT_LINE =
    "   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";
  const V6_WILDCARD_LINE = `   0: ${"0".repeat(32)}:46A1 ${"0".repeat(32)}:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0`;
  // An IPv6 address we deliberately don't attempt to decode (real ::1 loopback
  // is not all-zero once byte-order-encoded) — exercises the "ambiguous, stay
  // silent" path rather than us guessing at its reachability.
  const V6_UNRECOGNIZED_LINE =
    "   0: 0000000000000000FFFF00000100007F:46A1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";

  it('classifies an IPv4 0.0.0.0 wildcard LISTEN as "wide"', () => {
    expect(classifyProcNetTcpBind(`${HEADER}\n${V4_WILDCARD_LINE}\n`, PORT)).toBe("wide");
  });

  it('classifies an IPv4 127.0.0.1 LISTEN (no tcp6 entries) as "loopback"', () => {
    expect(classifyProcNetTcpBind(`${HEADER}\n${V4_LOOPBACK_LINE}\n`, PORT)).toBe("loopback");
  });

  it('classifies an absent entry (port not listed) as "inconclusive"', () => {
    expect(classifyProcNetTcpBind(`${HEADER}\n${V4_UNRELATED_PORT_LINE}\n`, PORT)).toBe(
      "inconclusive",
    );
  });

  it('classifies empty /proc/net/tcp content as "inconclusive"', () => {
    expect(classifyProcNetTcpBind("", PORT)).toBe("inconclusive");
  });

  it('classifies a tcp6 :: (all-zero, dual-stack) wildcard LISTEN as "wide"', () => {
    expect(classifyProcNetTcpBind("", PORT, `${HEADER}\n${V6_WILDCARD_LINE}\n`)).toBe("wide");
  });

  it('a tcp6 wildcard overrides an IPv4 loopback finding to "wide" (dual-stack is container-reachable)', () => {
    const tcp = `${HEADER}\n${V4_LOOPBACK_LINE}\n`;
    const tcp6 = `${HEADER}\n${V6_WILDCARD_LINE}\n`;
    expect(classifyProcNetTcpBind(tcp, PORT, tcp6)).toBe("wide");
  });

  it('an IPv4 loopback finding alongside an unrecognized (non-wildcard) tcp6 entry stays "inconclusive" (no false alarm)', () => {
    const tcp = `${HEADER}\n${V4_LOOPBACK_LINE}\n`;
    const tcp6 = `${HEADER}\n${V6_UNRECOGNIZED_LINE}\n`;
    expect(classifyProcNetTcpBind(tcp, PORT, tcp6)).toBe("inconclusive");
  });
});

describe("warnIfGatewayLoopbackOnly (Linux-only, warn-only, never throws)", () => {
  it("is a no-op on macOS regardless of local proc state (loopback-only is correct there)", () => {
    const originalWarn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      expect(() => warnIfGatewayLoopbackOnly(18081, "darwin")).not.toThrow();
      expect(calls).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("does not throw on Linux even when /proc/net/tcp is unreadable (stays silent)", () => {
    const originalWarn = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      // This test process's real /proc/net/tcp (Linux CI) won't have a LISTEN
      // entry for this arbitrary port, and on non-Linux `readFileSync` throws
      // and is swallowed — either way: no throw, no warning.
      expect(() => warnIfGatewayLoopbackOnly(65535, "linux")).not.toThrow();
      expect(calls).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("readGatewayRssKb", () => {
  it("returns a positive integer for a live PID (this test process)", () => {
    const rss = readGatewayRssKb(process.pid);
    expect(rss).not.toBeNull();
    expect(rss).toBeGreaterThan(0);
    expect(Number.isInteger(rss)).toBe(true);
  });

  it("returns null for a guard-violating PID (zero)", () => {
    expect(readGatewayRssKb(0)).toBeNull();
  });

  it("returns null when ps fails for a non-existent PID", () => {
    // Large PID unlikely to exist; reaches `ps` and exercises the
    // non-zero exit-code branch (not just the guard).
    expect(readGatewayRssKb(999_999)).toBeNull();
  });
});

describe("spawnDaemonToLog", () => {
  it("captures stdout and stderr to the log file in append mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-daemon-"));
    const log = join(dir, "out.log");
    try {
      const { pid } = spawnDaemonToLog(["sh", "-c", "echo hello; echo boom 1>&2"], dir, log);
      // Wait for the stub to exit.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && pidAlive(pid)) {
        await Bun.sleep(50);
      }
      expect(pidAlive(pid)).toBe(false);
      const contents = readFileSync(log, "utf-8");
      expect(contents).toContain("hello");
      expect(contents).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends across successive invocations (no truncation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-daemon-"));
    const log = join(dir, "out.log");
    try {
      const first = spawnDaemonToLog(["sh", "-c", "echo first"], dir, log);
      const second = spawnDaemonToLog(["sh", "-c", "echo second"], dir, log);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (pidAlive(first.pid) || pidAlive(second.pid))) {
        await Bun.sleep(50);
      }
      const contents = readFileSync(log, "utf-8");
      expect(contents).toContain("first");
      expect(contents).toContain("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // openlock-ab6: `openlock sandbox --no-attach` orphaned the gateway on
  // exit. Root cause — Bun.spawn defaults to `detached: false`, so the
  // gateway shared the CLI's process group/session; a short-lived scripted
  // invocation with no surviving controlling terminal delivers SIGHUP to that
  // whole session on exit, killing the "detached" (merely unref'd) gateway
  // too. `detached: true` calls setsid() so the gateway becomes its own
  // session/process-group leader — verified here via `ps -o pgid=` rather
  // than actually sending a signal (which would risk the test runner's own
  // session).
  it("spawns the daemon in its own process group (survives a SIGHUP to the caller's session)", async () => {
    function pgidOf(pid: number): string {
      const proc = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
      return new TextDecoder().decode(proc.stdout).trim();
    }

    const dir = mkdtempSync(join(tmpdir(), "spawn-daemon-detach-"));
    const log = join(dir, "out.log");
    try {
      const { pid } = spawnDaemonToLog(["sleep", "2"], dir, log);
      try {
        const childPgid = pgidOf(pid);
        const ownPgid = pgidOf(process.pid);
        expect(childPgid).not.toBe("");
        // A detached child is its own process-group leader: pgid === its pid,
        // and therefore differs from the caller's own pgid. Without
        // `detached: true` the child inherits the caller's pgid instead.
        expect(childPgid).toBe(String(pid));
        expect(childPgid).not.toBe(ownPgid);
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rotateLogIfLarge", () => {
  it("rotates a file at or over the threshold to .1, freeing the original path", () => {
    const dir = mkdtempSync(join(tmpdir(), "rotate-log-"));
    const log = join(dir, "gateway.log");
    try {
      writeFileSync(log, "x".repeat(1024));
      rotateLogIfLarge(log, 1024);
      expect(existsSync(log)).toBe(false);
      expect(readFileSync(`${log}.1`, "utf-8")).toBe("x".repeat(1024));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a file under the threshold untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "rotate-log-"));
    const log = join(dir, "gateway.log");
    try {
      writeFileSync(log, "small");
      rotateLogIfLarge(log, 1024);
      expect(existsSync(log)).toBe(true);
      expect(existsSync(`${log}.1`)).toBe(false);
      expect(readFileSync(log, "utf-8")).toBe("small");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-ops when the file doesn't exist (first run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rotate-log-"));
    const log = join(dir, "gateway.log");
    try {
      expect(() => rotateLogIfLarge(log, 1024)).not.toThrow();
      expect(existsSync(log)).toBe(false);
      expect(existsSync(`${log}.1`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing .1 backup, keeping only one generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "rotate-log-"));
    const log = join(dir, "gateway.log");
    try {
      writeFileSync(`${log}.1`, "stale backup");
      writeFileSync(log, "x".repeat(2048));
      rotateLogIfLarge(log, 1024);
      expect(existsSync(log)).toBe(false);
      expect(readFileSync(`${log}.1`, "utf-8")).toBe("x".repeat(2048));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
