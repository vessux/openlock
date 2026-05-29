import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderDefaultPolicy } from "./render-default-policies";

const ROOT = resolve(__dirname, "..");

describe("render-default-policies drift", () => {
  it("policies/default.yaml matches the rendered output", () => {
    const committed = readFileSync(resolve(ROOT, "policies", "default.yaml"), "utf-8");
    const rendered = renderDefaultPolicy();
    expect(rendered).toBe(committed);
  });
});
