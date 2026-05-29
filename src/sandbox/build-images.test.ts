import { describe, expect, it } from "bun:test";
import { updateImages } from "./build-images";

describe("updateImages", () => {
  it("calls ensureBase once with embedded base content", async () => {
    const ensureBaseCalls: string[] = [];
    await updateImages(
      { noCache: false },
      {
        ensureBase: async (content: string) => {
          ensureBaseCalls.push(content);
          return "ghcr.io/vessux/openlock-base:fake";
        },
      },
    );
    expect(ensureBaseCalls.length).toBe(1);
    expect(ensureBaseCalls[0]).toContain("FROM ubuntu:24.04");
  });
});
