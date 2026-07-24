import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigPath } from "./paths";

export type GlobalDefaultKey = "default_runtime" | "default_harness" | "default_provider";

/** Read-modify-write of one key line, leaving other keys intact. Uses a single
 * fd (open→read→truncate→write) so the read and write target the same inode
 * even if the path is swapped mid-call. NOTE: this is NOT a cross-process lock —
 * there is no flock, so two processes persisting different keys concurrently can
 * still lose one update (last truncate+write wins). openlock is single-user and
 * these writes are rare, so that race is accepted; see openlock bd for the
 * proper-locking follow-up if it ever matters. */
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
