// openlock-k5j2: this file intentionally has NO helper for spinning up a
// real gateway process, and no port-override seam. If a future test needs
// to exercise a live (throwaway) gateway — e.g. to reproduce the actual
// bind-conflict race behind classifyReadinessOutcome end-to-end — it MUST:
//
//   1. Take the port as a REQUIRED parameter to whatever helper it adds,
//      the same way ensure-provider.test.ts's `Shell` is threaded in
//      explicitly rather than defaulted — never fall back to the exported
//      `GATEWAY_PORT` constant.
//   2. Run against a scratch `$HOME`/state dir AND a scratch port. Never
//      18081, under any circumstance.
//   3. Never call the real `startGateway`/`stopGateway` against the
//      default port. That port is the developer's live gateway: an
//      optional test dependency once silently defaulted to the real thing
//      and deleted this project's real gateway providers, costing an
//      unrecoverable anthropic credential (see
//      feedback_no_optional_live_state_deps.md). A test that spins up a
//      real gateway process without threading its own scratch port is the
//      same shape of mistake with a different victim.
//
// A port-override seam (a module-global `_setGatewayPortForTests` setter)
// was added and then deliberately removed for this same reason: production
// code reading "whatever was last set" via a global is ITSELF the
// optional-with-a-real-default shape that rule forbids — a test that sets
// the override and forgets to reset it would silently redirect every OTHER
// test sharing the module. There is no seam to reach for here on purpose;
// the next author threads the port explicitly through their own test
// helper instead of inheriting an ambient default.
//
// openlock-x8m8 added `resolveGatewayPort`/`OPENLOCK_STATE_DIR` — a
// LEGITIMATE call-time seam (env read fresh on every call, never a global a
// test mutates and forgets to reset), tested directly below as pure
// functions. It does NOT relax the constraint above: `OPENLOCK_STATE_DIR`
// lets a test point a REAL `startGateway`/`gatewayStatus()` call at a
// scratch directory (save/restore the env var around one test, exactly like
// the `process.env.HOME` pattern already used in session-ops.test.ts), but
// nothing here spins up the actual gateway BINARY — that remains out of
// scope per point 3 above.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStateDir } from "../paths";
import {
  classifyProcNetTcpBind,
  classifyReadinessOutcome,
  clearGatewayStateFiles,
  findGatewayDriverMismatch,
  findGatewayPortRecordMismatch,
  formatForeignGatewayAdoptionError,
  formatGatewayDriverMismatchError,
  GATEWAY_PORT,
  gatewayStatus,
  getListeningPids,
  readGatewayPortRecord,
  readGatewayRssKb,
  renderGatewayConfigToml,
  resolveGatewayPort,
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

  // Upstream's driver-config mount path hard-errors unless this is set, and it
  // is a gateway-level TOML toggle -- not settable per `sandbox create`. Both
  // drivers gate independently, so both blocks need it (bd openlock-4sh).
  it("enables bind mounts for podman", () => {
    const out = renderGatewayConfigToml("podman", {
      supervisorImage: "img:latest",
      podmanSocket: "/run/podman/podman.sock",
    });
    expect(out).toContain("enable_bind_mounts = true");
  });

  it("enables bind mounts for docker", () => {
    const out = renderGatewayConfigToml("docker", { supervisorImage: "img:latest" });
    expect(out).toContain("enable_bind_mounts = true");
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

  it("pins ttl_secs=0 (openlock-4b1: never-expire local sandbox JWT is a fork default we don't inherit)", () => {
    // default_sandbox_token_ttl_secs() in openshell-core's GatewayJwtConfig
    // defaults to 0 today, but that's a fork default we've never asserted —
    // pin it explicitly so a future upstream sync flipping the default can't
    // silently resurrect the GH #75 JWT-expiry-on-resume bug.
    const out = renderGatewayConfigToml("podman", {
      supervisorImage: "img:latest",
      podmanSocket: "/run/podman/podman.sock",
      gatewayJwt: {
        signingKeyPath: "/s/jwt/signing.pem",
        publicKeyPath: "/s/jwt/public.pem",
        kidPath: "/s/jwt/kid",
      },
    });
    expect(out).toContain("ttl_secs = 0");
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

describe("findGatewayDriverMismatch (openlock-ox1)", () => {
  it("no mismatch when the running driver matches the requested runtime", () => {
    expect(findGatewayDriverMismatch("podman", "podman")).toBeNull();
    expect(findGatewayDriverMismatch("docker", "docker")).toBeNull();
  });

  it("returns the running driver when it differs from the requested runtime", () => {
    expect(findGatewayDriverMismatch("docker", "podman")).toBe("podman");
    expect(findGatewayDriverMismatch("podman", "docker")).toBe("docker");
  });

  // Migration/legacy safety (same discipline as openlock-04t's
  // findUnattachedCredentialBundles): a gateway started by a version of
  // openlock that predates driver-recording has no recorded driver at all.
  // undefined must NOT be read as "definitely mismatched" or "definitely
  // matching" — it means unknown, so never error.
  it("is never a mismatch when the running driver is undefined (legacy gateway, unknown)", () => {
    expect(findGatewayDriverMismatch("docker", undefined)).toBeNull();
    expect(findGatewayDriverMismatch("podman", undefined)).toBeNull();
  });
});

describe("formatGatewayDriverMismatchError (openlock-ox1)", () => {
  it("names BOTH the running driver and the requested runtime", () => {
    const msg = formatGatewayDriverMismatchError("docker", "podman");
    expect(msg).toContain("podman");
    expect(msg).toContain("docker");
  });

  it("points at `openlock gateway stop` as the remedy", () => {
    const msg = formatGatewayDriverMismatchError("docker", "podman");
    expect(msg).toContain("openlock gateway stop");
  });
});

describe("getListeningPids (openlock-k5j2)", () => {
  it("returns the probe's result unchanged when it finds a single listener", () => {
    expect(getListeningPids(18081, () => [56694])).toEqual([56694]);
  });

  // Ground truth from a real running gateway (2026-08-04): `lsof -ti :18081`
  // (WITHOUT -sTCP:LISTEN) returned three pids — 48431, 56694, 61433 — where
  // only 56694 was the actual gateway; the other two were connected clients.
  // The corrected invocation (`-sTCP:LISTEN`) is what the probe itself must
  // use to avoid ever returning that 3-pid shape in the first place, but
  // callers must ALSO tolerate a probe legitimately reporting more than one
  // pid (a forking/threaded server can hold multiple listening fds), so
  // membership — not array equality or index-0 — is the only safe check.
  it("can legitimately report multiple listening pids; the real listener must be a member, not necessarily first", () => {
    const pids = getListeningPids(18081, () => [61433, 56694]);
    expect(pids).toContain(56694);
  });

  it('returns [] (not null) when the probe ran but found no listener — a real "nothing listening"', () => {
    expect(getListeningPids(18081, () => [])).toEqual([]);
  });

  it("returns null when the probe itself couldn't run (e.g. lsof missing) — inconclusive, not a real result", () => {
    expect(getListeningPids(18081, () => null)).toBeNull();
  });
});

describe("classifyReadinessOutcome (openlock-k5j2)", () => {
  it('classifies as "not-ready" when the HTTP probe itself did not succeed yet', () => {
    expect(
      classifyReadinessOutcome({
        fetchOk: false,
        childAlive: true,
        gwPid: 100,
        listeningPids: [100],
      }),
    ).toBe("not-ready");
  });

  // THE bug: the readiness fetch succeeded (something answered), but our own
  // spawned child is no longer alive at that instant — the responder can
  // only be a foreign, pre-existing gateway. This is the exact race
  // exhibited in openlock-k5j2 (a bind failure on an already-occupied port
  // let the pre-existing gateway answer while our own child silently died).
  it('classifies as "foreign-dead-child" on fetchOk=true with a dead child — the exhibited bug', () => {
    expect(
      classifyReadinessOutcome({
        fetchOk: true,
        childAlive: false,
        gwPid: 100,
        listeningPids: null,
      }),
    ).toBe("foreign-dead-child");
  });

  it('classifies as "foreign-dead-child" regardless of what listeningPids says (child-death is dispositive on its own)', () => {
    expect(
      classifyReadinessOutcome({
        fetchOk: true,
        childAlive: false,
        gwPid: 100,
        listeningPids: [100], // even if lsof still sees it as (momentarily) listed
      }),
    ).toBe("foreign-dead-child");
  });

  it('classifies as "foreign-lsof-mismatch" when the child is alive but not among the port\'s listeners', () => {
    expect(
      classifyReadinessOutcome({
        fetchOk: true,
        childAlive: true,
        gwPid: 100,
        listeningPids: [999],
      }),
    ).toBe("foreign-lsof-mismatch");
  });

  it('classifies as "ready" when the child is alive and IS among the listeners', () => {
    expect(
      classifyReadinessOutcome({
        fetchOk: true,
        childAlive: true,
        gwPid: 100,
        listeningPids: [100],
      }),
    ).toBe("ready");
  });

  it('classifies as "ready" when listeningPids is null (lsof unavailable) — inconclusive must never fail a healthy start', () => {
    expect(
      classifyReadinessOutcome({
        fetchOk: true,
        childAlive: true,
        gwPid: 100,
        listeningPids: null,
      }),
    ).toBe("ready");
  });

  it('classifies as "ready" when multiple pids are listening and gwPid is among them (set membership, not equality)', () => {
    expect(
      classifyReadinessOutcome({
        fetchOk: true,
        childAlive: true,
        gwPid: 56694,
        listeningPids: [56694, 61433],
      }),
    ).toBe("ready");
  });
});

describe("formatForeignGatewayAdoptionError (openlock-k5j2)", () => {
  it("names the port and includes the caller-supplied detail", () => {
    const msg = formatForeignGatewayAdoptionError(18081, "pid 100 exited");
    expect(msg).toContain("18081");
    expect(msg).toContain("pid 100 exited");
  });

  it("does NOT tell the user to run `openlock gateway stop` (this invocation never owned the gateway, unlike formatGatewayDriverMismatchError's case)", () => {
    const msg = formatForeignGatewayAdoptionError(18081, "pid 100 exited");
    expect(msg).not.toContain("openlock gateway stop");
  });

  it("makes clear this is a gateway the invocation does not own", () => {
    const msg = formatForeignGatewayAdoptionError(18081, "pid 100 exited");
    expect(msg.toLowerCase()).toContain("does not own");
  });
});

describe("resolveGatewayPort (openlock-x8m8)", () => {
  it("returns GATEWAY_PORT (18081) for the default state dir, byte-identical to pre-x8m8 behavior", () => {
    expect(resolveGatewayPort(defaultStateDir())).toBe(GATEWAY_PORT);
  });

  it("returns GATEWAY_PORT for the default state dir even with a non-canonical (trailing-slash) spelling", () => {
    expect(resolveGatewayPort(`${defaultStateDir()}/`)).toBe(GATEWAY_PORT);
  });

  it("returns a DIFFERENT, derived port for a relocated state dir", () => {
    const port = resolveGatewayPort("/tmp/some-other-openlock-state");
    expect(port).not.toBe(GATEWAY_PORT);
  });

  it("stays within the documented private band (18082-18999), clear of both platforms' ephemeral ranges", () => {
    const dirs = [
      "/tmp/openlock-a",
      "/tmp/openlock-b",
      "/home/ci/project-1/.state",
      "/home/ci/project-2/.state",
      "/var/folders/x/y/z/openlock-state",
    ];
    for (const dir of dirs) {
      const port = resolveGatewayPort(dir);
      expect(port).toBeGreaterThanOrEqual(18082);
      expect(port).toBeLessThanOrEqual(18999);
    }
  });

  it("is deterministic: same path in, same port out", () => {
    const a = resolveGatewayPort("/tmp/openlock-state-x");
    const b = resolveGatewayPort("/tmp/openlock-state-x");
    expect(a).toBe(b);
  });

  it("different relocated paths can (and do, for these examples) derive different ports", () => {
    const a = resolveGatewayPort("/tmp/openlock-state-x");
    const b = resolveGatewayPort("/tmp/openlock-state-y");
    expect(a).not.toBe(b);
  });
});

describe("readGatewayPortRecord / findGatewayPortRecordMismatch (openlock-x8m8)", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openlock-port-record-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readGatewayPortRecord returns undefined when the file doesn't exist", () => {
    expect(readGatewayPortRecord(dir)).toBeUndefined();
  });

  it("readGatewayPortRecord reads back a written value", () => {
    writeFileSync(join(dir, "gateway.port"), "18123\n");
    expect(readGatewayPortRecord(dir)).toBe(18123);
  });

  it("readGatewayPortRecord returns undefined for unparseable content, never throws", () => {
    writeFileSync(join(dir, "gateway.port"), "not-a-number");
    expect(readGatewayPortRecord(dir)).toBeUndefined();
  });

  it("findGatewayPortRecordMismatch: no report when there's no record yet (never a false positive)", () => {
    expect(findGatewayPortRecordMismatch(undefined, 18081)).toBeNull();
  });

  it("findGatewayPortRecordMismatch: no report when the record matches the derived value", () => {
    expect(findGatewayPortRecordMismatch(18081, 18081)).toBeNull();
  });

  it("findGatewayPortRecordMismatch: returns the stale recorded port when it disagrees with derived", () => {
    expect(findGatewayPortRecordMismatch(18500, 18081)).toBe(18500);
  });
});

describe("gatewayStatus port field (openlock-x8m8)", () => {
  // Exercises the real gatewayStatus() against a SCRATCH state dir via
  // OPENLOCK_STATE_DIR, save/restored around each test — never the real
  // state dir, never the real gateway (see this file's header comment).
  const oldOverride = process.env.OPENLOCK_STATE_DIR;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openlock-gateway-status-"));
    process.env.OPENLOCK_STATE_DIR = dir;
  });

  afterEach(() => {
    if (oldOverride === undefined) delete process.env.OPENLOCK_STATE_DIR;
    else process.env.OPENLOCK_STATE_DIR = oldOverride;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a derived (non-18081) port for a relocated, empty scratch state dir", () => {
    const status = gatewayStatus();
    expect(status.running).toBe(false);
    expect(status.port).toBe(resolveGatewayPort(dir));
    expect(status.port).not.toBe(GATEWAY_PORT);
  });

  it("port is present even when a pid file exists but the pid is dead (not running)", () => {
    writeFileSync(join(dir, "gateway.pid"), "999999999");
    const status = gatewayStatus();
    expect(status.running).toBe(false);
    expect(status.port).toBe(resolveGatewayPort(dir));
  });
});

describe("clearGatewayStateFiles (openlock-u60k)", () => {
  // Both abort-after-spawn paths in waitForGatewayReady now route through
  // this helper (see its doc comment) instead of keeping their own copy of
  // the three unlinks — this is the honest unit-testable surface of that
  // change. waitForGatewayReady itself stays out of reach here on purpose:
  // it calls process.exit(1) directly, and no port-override seam exists for
  // startGateway (see this file's header comment) to drive it end-to-end.
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openlock-clear-gateway-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the pid, driver, and port files when all three are present", () => {
    writeFileSync(join(dir, "gateway.pid"), "12345");
    writeFileSync(join(dir, "gateway.driver"), "podman");
    writeFileSync(join(dir, "gateway.port"), "18081");
    clearGatewayStateFiles(dir);
    expect(existsSync(join(dir, "gateway.pid"))).toBe(false);
    expect(existsSync(join(dir, "gateway.driver"))).toBe(false);
    expect(existsSync(join(dir, "gateway.port"))).toBe(false);
  });

  it("no-ops cleanly when none of the three files exist", () => {
    expect(() => clearGatewayStateFiles(dir)).not.toThrow();
  });

  it("removes whichever subset is present without erroring on the missing ones", () => {
    writeFileSync(join(dir, "gateway.pid"), "12345");
    clearGatewayStateFiles(dir);
    expect(existsSync(join(dir, "gateway.pid"))).toBe(false);
  });
});
