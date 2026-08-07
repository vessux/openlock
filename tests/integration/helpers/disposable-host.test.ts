import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isDisposableHost, requireDisposableHost } from "./disposable-host";

// Env save/restore pattern matches src/paths.test.ts's resolveConfigDir /
// resolveStateDir suites — save the real value once, force a known state
// per-test, restore exactly (including "was unset") in afterEach so this
// suite can never leak OPENLOCK_DISPOSABLE_HOST into a sibling test file,
// nor let a real ambient value (e.g. this file itself running inside the
// live-integration CI job, where the var IS "1") mask a bug in the
// fail-closed logic.
describe("isDisposableHost / requireDisposableHost (bd openlock-o4t4)", () => {
  const oldMarker = process.env.OPENLOCK_DISPOSABLE_HOST;

  afterEach(() => {
    if (oldMarker === undefined) delete process.env.OPENLOCK_DISPOSABLE_HOST;
    else process.env.OPENLOCK_DISPOSABLE_HOST = oldMarker;
  });

  describe("isDisposableHost", () => {
    it("is false when unset", () => {
      delete process.env.OPENLOCK_DISPOSABLE_HOST;
      expect(isDisposableHost()).toBe(false);
    });

    it("is false when set to an empty string", () => {
      process.env.OPENLOCK_DISPOSABLE_HOST = "";
      expect(isDisposableHost()).toBe(false);
    });

    it("is false for a truthy-looking but non-'1' value ('true')", () => {
      process.env.OPENLOCK_DISPOSABLE_HOST = "true";
      expect(isDisposableHost()).toBe(false);
    });

    it("is false for '0'", () => {
      process.env.OPENLOCK_DISPOSABLE_HOST = "0";
      expect(isDisposableHost()).toBe(false);
    });

    it("is true only for the exact string '1'", () => {
      process.env.OPENLOCK_DISPOSABLE_HOST = "1";
      expect(isDisposableHost()).toBe(true);
    });
  });

  describe("requireDisposableHost", () => {
    beforeEach(() => {
      delete process.env.OPENLOCK_DISPOSABLE_HOST;
    });

    it("throws when the marker is absent", () => {
      expect(() => requireDisposableHost("sandbox create against the real dev gateway")).toThrow();
    });

    it("throw message names the attempted action, explains why it refused, and how to satisfy it", () => {
      let thrown: unknown;
      try {
        requireDisposableHost("sandbox create against the real dev gateway");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      // WHAT was being attempted.
      expect(message).toContain("sandbox create against the real dev gateway");
      // WHY it refused: names the marker and says this protects real state.
      expect(message).toContain("OPENLOCK_DISPOSABLE_HOST");
      expect(message.toLowerCase()).toContain("real");
      // HOW to satisfy it: points at the CI job that sets it, and does NOT
      // tell the reader to just set the var locally (that would defeat the
      // whole guard) — it should instead point at the local disposable-host
      // tracking issue.
      expect(message).toContain("live-integration");
      expect(message).toContain("openlock-uze8");
    });

    it("does not throw when the marker is exactly '1'", () => {
      process.env.OPENLOCK_DISPOSABLE_HOST = "1";
      expect(() =>
        requireDisposableHost("sandbox create against the real dev gateway"),
      ).not.toThrow();
    });

    it("still throws for a non-'1' value (e.g. 'true') — fail-closed on any unrecognized value", () => {
      process.env.OPENLOCK_DISPOSABLE_HOST = "true";
      expect(() => requireDisposableHost("sandbox create against the real dev gateway")).toThrow();
    });
  });
});
