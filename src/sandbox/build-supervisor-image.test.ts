import { describe, it, expect } from "bun:test";
import { supervisorImageTag, supervisorDockerfile } from "./build-supervisor-image";

describe("build-supervisor-image", () => {
  it("generates a stable image tag from binary path", () => {
    const tag = supervisorImageTag("/some/path/openshell-sandbox");
    expect(tag).toBe("openlock/supervisor:latest");
  });

  it("generates a FROM scratch Dockerfile", () => {
    const df = supervisorDockerfile();
    expect(df).toContain("FROM scratch");
    expect(df).toContain("/openshell-sandbox");
  });
});
