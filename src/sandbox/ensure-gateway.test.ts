import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGatewayRssKb, renderGatewayConfigToml, spawnDaemonToLog } from "./ensure-gateway";
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
});
