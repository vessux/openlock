import { describe, expect, it } from "bun:test";
import { chooseRuntimeFromProbes, formatWizardPrompt } from "./runtime-wizard";

describe("formatWizardPrompt", () => {
  it("includes both options with recommendation marker when both present", () => {
    const msg = formatWizardPrompt({ podman: true, docker: true });
    expect(msg).toContain("podman");
    expect(msg).toContain("docker");
    expect(msg).toContain("recommended"); // podman wins
  });
  it("explains missing binaries", () => {
    const msg = formatWizardPrompt({ podman: false, docker: false });
    expect(msg).toMatch(/no container runtime/i);
  });
});

describe("chooseRuntimeFromProbes (non-interactive)", () => {
  it("returns podman as recommended when both installed", () => {
    expect(chooseRuntimeFromProbes({ podman: true, docker: true })).toBe("podman");
  });
  it("returns docker when only docker installed", () => {
    expect(chooseRuntimeFromProbes({ podman: false, docker: true })).toBe("docker");
  });
  it("returns podman when only podman installed", () => {
    expect(chooseRuntimeFromProbes({ podman: true, docker: false })).toBe("podman");
  });
  it("returns null when neither installed", () => {
    expect(chooseRuntimeFromProbes({ podman: false, docker: false })).toBe(null);
  });
});
