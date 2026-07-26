import { buildProxyLogGrepCmd, execCaptureInSandbox } from "./proxy-log";

const TLS_TERMINATION_MARKER = "TLS termination";

export type TlsFallbackVerdict = "enabled" | "disabled" | "unknown";

/**
 * Scan (already-grepped) proxy-log content for the supervisor's one-time
 * TLS-termination ConfigStateChange event, emitted once at proxy startup in
 * the fork's openshell-supervisor-network (`run.rs`):
 *
 *   - success: `... OCSF CONFIG:ENABLED [INFO] TLS termination enabled: ...`
 *   - failure: `... OCSF CONFIG:DISABLED [MED] Failed to write CA files, TLS
 *     termination disabled: ...` (or "Failed to generate ephemeral CA, ...")
 *
 * "disabled" means cold-start ephemeral-CA generation or the CA file write to
 * /etc/openshell-tls failed, so the proxy falls back to a raw
 * copy_bidirectional byte tunnel with ZERO L7 enforcement for the rest of
 * that supervisor's lifetime — no cred_inject strip-and-replace, no
 * per-binary allowed_secrets scoping, no content policy. Only the earlier L4
 * allowed-IP/SSRF check still applies (bd openlock-bj2).
 *
 * Substring-matches on the literal message text rather than parsing the
 * shorthand `CONFIG:DISABLED` state tag: that state is reused by several
 * unrelated ConfigStateChange events (inference-route reload, service
 * routing, …), so the state tag alone can't disambiguate — the "TLS
 * termination" phrase is what's actually unique to this event.
 *
 * Scans every matching line and keeps the LAST one, so a stale line from an
 * earlier supervisor run sitting in an un-rotated log can't shadow a more
 * recent, contradicting one.
 *
 * "unknown" covers three cases the caller cannot tell apart from content
 * alone, and deliberately does NOT: no TLS state was ever configured because
 * the policy's network mode isn't `proxy` (nothing to report — not a
 * failure); the event hasn't been flushed to disk yet (cold-start race); or
 * the log is empty/unreadable. Callers must treat "unknown" as "can't
 * confirm", never as an implicit pass — see decideTlsFallbackAction.
 */
export function scanTlsFallbackState(logContent: string): TlsFallbackVerdict {
  let verdict: TlsFallbackVerdict = "unknown";
  for (const line of logContent.split("\n")) {
    if (!line.includes(TLS_TERMINATION_MARKER)) continue;
    if (line.includes("TLS termination disabled")) {
      verdict = "disabled";
    } else if (line.includes("TLS termination enabled")) {
      verdict = "enabled";
    }
  }
  return verdict;
}

export interface FetchTlsFallbackOpts {
  /** Total read attempts before giving up as "unknown". Default 3. */
  attempts?: number;
  /** Delay between attempts. Default 300ms. */
  delayMs?: number;
}

/**
 * Fetch and scan the proxy log for the TLS-termination verdict, with a
 * bounded retry.
 *
 * Right after create/reattach the event may not have been flushed to the log
 * file yet (cold-start race between the supervisor reaching Ready — which
 * `waitForSandboxReady` already gated on — and its tracing writer's next
 * flush), so a single empty/negative read must not be mistaken for "network
 * mode isn't proxy" and silently waved through. Stops polling as soon as a
 * definitive verdict is seen: the event fires exactly once per supervisor
 * process lifetime, so there's nothing to gain from continuing once it has
 * landed. Cheap either way — a bounded number of `openshell sandbox exec`
 * calls reading an already-accessible log file, no podman/runtime
 * introspection.
 */
export async function fetchTlsFallbackVerdict(
  name: string,
  opts: FetchTlsFallbackOpts = {},
): Promise<TlsFallbackVerdict> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 300;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const content = await execCaptureInSandbox(name, buildProxyLogGrepCmd(TLS_TERMINATION_MARKER));
    const verdict = scanTlsFallbackState(content);
    if (verdict !== "unknown") return verdict;
    if (attempt < attempts) await Bun.sleep(delayMs);
  }
  return "unknown";
}

/** What runSandbox should do once the verdict is known. */
export type TlsFallbackAction = "proceed" | "warn-unknown" | "prompt" | "block";

/**
 * Decide how to handle the TLS-fallback verdict on create/attach/reattach.
 *
 * - "enabled": proceed silently — the healthy, expected case.
 * - "unknown": can't confirm either way (see scanTlsFallbackState) — proceed,
 *   but WARN so the enforcement gap isn't silent. Mirrors drift.ts's
 *   `storedHash`/`currentHash` undefined rule: "can't compare ⇒ proceed,
 *   never a false positive."
 * - "disabled": a CONFIRMED loss of the credential/content moat for this
 *   session's entire lifetime — not a staleness/convenience issue like
 *   drift.ts's analogous "cold inputs changed" case. An interactive terminal
 *   gets the same blocking y/N precedent drift.ts uses for its "prompt"
 *   action (default No — see promptRebuildOnDrift/promptProceedWithTlsDisabled).
 *   A NON-interactive run deliberately does NOT follow drift's "warn and
 *   proceed anyway" fallback: there is no one to consent, and this product's
 *   core claim is the credential moat, so silently shipping a session with
 *   none of its L7 enforcement would be exactly the silent security
 *   regression this check exists to catch. It hard-BLOCKs instead. See bd
 *   openlock-bj2.
 */
export function decideTlsFallbackAction(args: {
  verdict: TlsFallbackVerdict;
  interactive: boolean;
}): TlsFallbackAction {
  if (args.verdict === "enabled") return "proceed";
  if (args.verdict === "unknown") return "warn-unknown";
  return args.interactive ? "prompt" : "block";
}

/** Message for the "disabled"/blocked case — names the cause and the fix. */
export function formatTlsFallbackBlockedMessage(name: string): string {
  return (
    `openlock: sandbox "${name}" has TLS termination DISABLED. The in-container proxy's ` +
    "ephemeral CA failed to generate or failed to write to /etc/openshell-tls at supervisor " +
    "startup, so this session gets NO per-binary credential scoping and NO L7 content-policy " +
    "enforcement (only the coarse allowed-host/SSRF check still applies) — a silent loss of the " +
    "credential moat this product claims. This is commonly a rootless-podman uid-remap / " +
    `mount-permission problem. Run \`openlock logs ${name}\` for the supervisor's own error, and ` +
    "`openlock doctor` to check subuid/subgid ranges. Recreate the sandbox once fixed " +
    "(`openlock sandbox --rebuild`)."
  );
}

/** Message for the "unknown" case — a visible warning, not a block. */
export function formatTlsFallbackUnknownWarning(name: string): string {
  return (
    `openlock: could not confirm TLS-termination state for sandbox "${name}" from its proxy log ` +
    "(no ConfigStateChange event seen). If this session's policy uses network proxy mode, L7 " +
    `credential/content enforcement may not be active — check \`openlock logs ${name}\`.`
  );
}
