import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderDefaultPolicy } from "./render-default-policies";

const ROOT = resolve(__dirname, "..");

describe("render-default-policies drift", () => {
  for (const file of ["default.yaml", "default-js.yaml", "default-py.yaml", "default-js-py.yaml"]) {
    it(`policies/${file} matches the rendered output`, () => {
      const committed = readFileSync(resolve(ROOT, "policies", file), "utf-8");
      const rendered = renderDefaultPolicy(file.replace(".yaml", ""));
      expect(rendered).toBe(committed);
    });
  }
});
