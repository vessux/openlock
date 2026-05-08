import { describe, expect, it, spyOn } from "bun:test";
import { completeCmd } from "./complete";

describe("completeCmd", () => {
  it("prints bash script and exits 0 when given 'bash'", async () => {
    const writes: string[] = [];
    spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as never);
    const code = await completeCmd(["bash"]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("complete -F _openlock openlock");
  });

  it("prints zsh script with #compdef header for 'zsh'", async () => {
    const writes: string[] = [];
    spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as never);
    const code = await completeCmd(["zsh"]);
    expect(code).toBe(0);
    expect(writes.join("").split("\n")[0]).toBe("#compdef openlock");
  });

  it("prints fish script for 'fish'", async () => {
    const writes: string[] = [];
    spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as never);
    const code = await completeCmd(["fish"]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("complete -c openlock");
  });

  it("returns exit code 1 on unknown shell", async () => {
    const errs: string[] = [];
    spyOn(console, "error").mockImplementation(((s: string) => {
      errs.push(s);
    }) as never);
    const code = await completeCmd(["powershell"]);
    expect(code).toBe(1);
    expect(errs.join(" ")).toContain("bash|zsh|fish");
  });

  it("returns exit code 1 when no shell is given", async () => {
    const code = await completeCmd([]);
    expect(code).toBe(1);
  });
});
