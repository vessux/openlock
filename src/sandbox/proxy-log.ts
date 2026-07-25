import { buildOpenshellExecArgv } from "./container";
import { getCliInvocation } from "./fork-binaries";

/**
 * Where the in-container openshell supervisor/proxy writes its OCSF audit
 * log (per-request L7 allow/deny decisions and startup config events),
 * date-rotated. Root-owned, world-readable. The glob handles date rollover;
 * the `openshell-ocsf.<date>.log` sibling is intentionally NOT matched
 * (`openshell.*` requires a literal dot after `openshell`).
 *
 * Single source of truth for the path so `openlock logs` (buildProxyLogCmd)
 * and the TLS-fallback health check (tls-state.ts, buildProxyLogGrepCmd)
 * can't drift apart.
 */
export const PROXY_LOG_GLOB = "/var/log/openshell.*.log";

const DEFAULT_TAIL_LINES = 200;

/**
 * Build the in-sandbox command that surfaces the openshell proxy's OCSF audit
 * log: per-request L7 allow/deny decisions (method, URL, policy, engine, and
 * the calling binary) written by the in-container supervisor/proxy — the
 * data-plane the host gateway log never shows.
 */
export function buildProxyLogCmd(opts: { follow?: boolean; lines?: number } = {}): string[] {
  const n =
    typeof opts.lines === "number" && Number.isInteger(opts.lines) && opts.lines >= 0
      ? opts.lines
      : DEFAULT_TAIL_LINES;
  const flags = opts.follow === true ? `-n ${n} -f` : `-n ${n}`;
  return [
    "sh",
    "-c",
    `tail ${flags} ${PROXY_LOG_GLOB} 2>/dev/null || echo "(no proxy log found at ${PROXY_LOG_GLOB})"`,
  ];
}

/**
 * Build the in-sandbox command that greps the FULL proxy log (every rotated
 * date file, no line-count window) for a literal substring. Unlike
 * buildProxyLogCmd's `tail -n N` (fine for "show me recent activity"), a
 * health check for a rare one-time startup event must not miss a line that a
 * fixed tail window could push out on a long-lived, chatty sandbox — so this
 * greps the whole file instead. Still cheap: bounded by on-disk log size, no
 * podman/runtime introspection.
 *
 * `literal` must be a fixed, code-controlled string, never external input —
 * it is interpolated into a `sh -c` string (single-quoted) and passed to
 * `grep -F` (literal match, not a regex) rather than sanitized generically.
 */
export function buildProxyLogGrepCmd(literal: string): string[] {
  // Defence in depth: the contract above says "code-controlled constant", but
  // a single quote would break out of the surrounding '...' and turn this into
  // arbitrary shell. Fail loudly rather than emit a broken/injectable command
  // if a future caller ever passes something dynamic.
  if (/['\\]/.test(literal)) {
    throw new Error(
      `buildProxyLogGrepCmd: literal must not contain quotes or backslashes: ${literal}`,
    );
  }
  return ["sh", "-c", `grep -h -F '${literal}' ${PROXY_LOG_GLOB} 2>/dev/null || true`];
}

/**
 * Run `cmd` inside the sandbox via `openshell sandbox exec` and capture its
 * stdout, unlike execCmd/execBash in container.ts which inherit stdio for
 * interactive use. Returns "" on a non-zero exit (sandbox not reachable,
 * transport error) rather than throwing — callers treat that the same as "no
 * evidence yet", not a hard error.
 */
export async function execCaptureInSandbox(name: string, cmd: string[]): Promise<string> {
  const cli = await getCliInvocation();
  const argv = buildOpenshellExecArgv(cli.argv, name, cmd, { tty: "off" });
  const proc = Bun.spawn(argv, { cwd: cli.cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return code === 0 ? out : "";
}
