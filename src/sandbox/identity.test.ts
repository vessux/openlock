import { describe, expect, it } from "bun:test";
import { friendlyNameFromId, newSessionId } from "./identity";

describe("identity", () => {
  it("newSessionId returns a UUIDv7-shaped string", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("newSessionId is monotonic across rapid calls", async () => {
    const a = newSessionId();
    await Bun.sleep(2);
    const b = newSessionId();
    expect(a < b).toBe(true);
  });

  it("friendlyNameFromId concatenates basename and 6-hex suffix", () => {
    const id = "0190a2d5-7c6a-7b3e-8f4d-abcdef123456";
    expect(friendlyNameFromId("openlock", id)).toBe("openlock-123456");
  });

  it("friendlyNameFromId sanitizes basename: lowercase, alnum-and-dash only", () => {
    const id = "0190a2d5-7c6a-7b3e-8f4d-abcdef123456";
    expect(friendlyNameFromId("My Repo!", id)).toBe("my-repo-123456");
  });

  it("friendlyNameFromId falls back to 'sandbox' when basename is empty or only special chars", () => {
    const id = "0190a2d5-7c6a-7b3e-8f4d-abcdef123456";
    expect(friendlyNameFromId("", id)).toBe("sandbox-123456");
    expect(friendlyNameFromId("!!!", id)).toBe("sandbox-123456");
  });

  // The gateway rejects sandbox names over 19 chars (DNS-routable label
  // budget, arrived with upstream's workspace model in the v0.8.0 fork sync).
  // Before truncation, a project dir over 12 chars made `openlock sandbox`
  // fail outright with InvalidArgument.
  it("friendlyNameFromId never exceeds the 19-char routable name limit", () => {
    const id = "0190a2d5-7c6a-7b3e-8f4d-abcdef123456";
    for (const basename of [
      "my-web-service",
      "a-very-long-project-directory-name",
      "openlock",
      "x",
      "",
      "Some Repo With Spaces And More",
    ]) {
      const name = friendlyNameFromId(basename, id);
      expect(name.length).toBeLessThanOrEqual(19);
      // Must remain a canonical DNS label: starts alphanumeric, no trailing dash.
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    }
  });

  it("friendlyNameFromId truncates the project segment but keeps the id suffix", () => {
    const id = "0190a2d5-7c6a-7b3e-8f4d-abcdef123456";
    expect(friendlyNameFromId("my-web-service", id)).toBe("my-web-servi-123456");
    // Short names are untouched.
    expect(friendlyNameFromId("openlock", id)).toBe("openlock-123456");
  });

  it("friendlyNameFromId strips a hyphen exposed by truncation", () => {
    const id = "0190a2d5-7c6a-7b3e-8f4d-abcdef123456";
    // "my-web-server-api" truncated to 12 is "my-web-serve"; a name whose
    // 12-char prefix ends on the delimiter must not keep it.
    expect(friendlyNameFromId("my-web-serve-api", id)).toBe("my-web-serve-123456");
    expect(friendlyNameFromId("abcdefghijkl-mno", id)).toBe("abcdefghijkl-123456");
    expect(friendlyNameFromId("abcdefghijk-mno", id)).toBe("abcdefghijk-123456");
  });
});
