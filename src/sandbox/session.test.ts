import { describe, expect, it } from "bun:test";
import { shouldStopGateway } from "./session";

describe("shouldStopGateway", () => {
  it("returns false when keepGateway is true regardless of running sandboxes", () => {
    expect(shouldStopGateway({ keepGateway: true, otherSandboxes: 0 })).toBe(false);
    expect(shouldStopGateway({ keepGateway: true, otherSandboxes: 3 })).toBe(false);
  });

  it("returns true when keepGateway is false and no other sandboxes", () => {
    expect(shouldStopGateway({ keepGateway: false, otherSandboxes: 0 })).toBe(true);
  });

  it("returns false when keepGateway is false but other sandboxes are running", () => {
    expect(shouldStopGateway({ keepGateway: false, otherSandboxes: 1 })).toBe(false);
    expect(shouldStopGateway({ keepGateway: false, otherSandboxes: 5 })).toBe(false);
  });
});
