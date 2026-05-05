import { describe, it, expect } from "bun:test";
import { selectPolicy } from "./select-policy";

describe("selectPolicy", () => {
  it("returns default.yaml for no caps", () => {
    expect(selectPolicy([])).toMatch(/policies\/default\.yaml$/);
  });

  it("returns default-js.yaml for js", () => {
    expect(selectPolicy(["js"])).toMatch(/policies\/default-js\.yaml$/);
  });

  it("returns default-py.yaml for py", () => {
    expect(selectPolicy(["py"])).toMatch(/policies\/default-py\.yaml$/);
  });

  it("returns default-js-py.yaml for both", () => {
    expect(selectPolicy(["js", "py"])).toMatch(/policies\/default-js-py\.yaml$/);
  });
});
