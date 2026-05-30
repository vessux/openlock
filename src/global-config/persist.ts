import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigPath } from "./paths";

export type GlobalDefaultKey = "default_runtime" | "default_harness" | "default_provider";

/** Single-fd read+truncate+write avoids the path-based TOCTOU race a separate
 * readFileSync/writeFileSync pair would create. Replaces any existing line for
 * `key`, leaving other keys intact. */
export function persistGlobalDefaultTo(path: string, key: GlobalDefaultKey, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a+", 0o600);
  try {
    const existing = readFileSync(fd, "utf-8");
    const keyRe = new RegExp(`^\\s*${key}\\s*:`);
    const lines = existing.split("\n").filter((l) => !keyRe.test(l));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}: ${value}`);
    lines.push("");
    const out = lines.join("\n");
    ftruncateSync(fd, 0);
    writeSync(fd, out, 0);
  } finally {
    closeSync(fd);
  }
}

export function persistGlobalDefault(key: GlobalDefaultKey, value: string): void {
  persistGlobalDefaultTo(globalConfigPath(), key, value);
}
