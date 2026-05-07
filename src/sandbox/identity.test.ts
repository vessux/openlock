import { describe, it, expect } from "bun:test";
import { newSessionId, friendlyNameFromId } from "./identity";

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
});
