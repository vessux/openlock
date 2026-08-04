import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import {
  type ClassifiedSession,
  type CleanOpts,
  classifyAll,
  cleanSession,
  REAL_CLEAN_DEPS,
  REAL_GATEWAY_SELF_HEAL_DEPS,
  selfHealGatewayIfRuntimeConfigured,
} from "../sandbox/session-ops";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  copy: { type: "string" },
  all: { type: "boolean" },
  stale: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export interface BulkCleanDeps {
  /** Real: selfHealGatewayIfRuntimeConfigured. REQUIRED — no
   * optional-with-a-real-default (openlock-k5j2 /
   * feedback_no_optional_live_state_deps); see REAL_BULK_CLEAN_DEPS below
   * for the production wiring. */
  selfHealGateway: () => Promise<unknown>;
  /** Real: classifyAll. REQUIRED, same reasoning. */
  classifyAll: () => Promise<ClassifiedSession[]>;
  /** Real: cleanSession. REQUIRED, same reasoning. */
  cleanSession: (name: string, opts: CleanOpts) => Promise<void>;
}

/** Production wiring for BulkCleanDeps (openlock-k5j2) — single source of
 * truth for the real dependencies, so cleanCmd doesn't repeat the wiring. */
export const REAL_BULK_CLEAN_DEPS: BulkCleanDeps = {
  selfHealGateway: () => selfHealGatewayIfRuntimeConfigured(REAL_GATEWAY_SELF_HEAL_DEPS),
  classifyAll,
  cleanSession: (name, opts) => cleanSession(name, opts, REAL_CLEAN_DEPS),
};

/**
 * `--all`/`--stale` bulk clean. Self-heals the gateway ONCE, BEFORE
 * classifyAll (openlock-kx8 correction) — NOT per-session inside
 * cleanSession's own self-heal, which runs too late for this path.
 *
 * Why: classifyAll's per-session `getSandboxState` call maps ANY gateway-down
 * transport error to `"missing"` (container.ts), and classifySession maps
 * `"missing"` container state straight to classification `"missing"`
 * (reap.ts). So with the gateway down, EVERY session — healthy running ones
 * included — misclassifies as missing, and `--stale` targets
 * `exited || missing`, i.e. all of them. Before cleanSession self-healed,
 * that was caught downstream: `deleteSandbox` hit the same transport error
 * and threw, so the per-session catch below left the (mis-classified but
 * actually healthy) session untouched — a safe failure. Once cleanSession
 * self-heals the gateway before its own delete, that safety net disappears:
 * the delete would succeed against a gateway that had *just* come up,
 * destroying containers that were never actually stale. So classification
 * itself must happen against an accurate, live-gateway view of the world —
 * bring the gateway up before classifyAll, not per-session after it.
 *
 * Same no-runtime gate as cleanSession: bring-up is skipped (not attempted)
 * when no runtime is resolvable without the interactive wizard, so a bulk
 * sweep on a genuinely runtime-less box never blocks on the picker — and
 * still proceeds to classify+clean (cleanSession's own no-runtime branch
 * reaps local-only state directly in that case).
 *
 * If bring-up IS attempted and fails, this aborts BEFORE classifyAll —
 * classifying (let alone deleting) against a gateway confirmed to be down
 * would reproduce the exact bug this exists to prevent. Nothing is cleaned;
 * the caller must report that plainly, not partial/false success.
 */
export async function runBulkClean(
  stale: boolean,
  copyDir: string | undefined,
  deps: BulkCleanDeps,
): Promise<number> {
  const selfHeal = deps.selfHealGateway;
  const classify = deps.classifyAll;
  const clean = deps.cleanSession;

  try {
    await selfHeal();
  } catch (e) {
    console.error(
      `clean: gateway is down and could not be started (${(e as Error).message}); nothing cleaned.`,
    );
    return 1;
  }

  const rows = await classify();
  // openlock-vtl: "unreachable" (we couldn't determine this session's real
  // state because the gateway call itself failed) must never be treated as
  // safe to act on, for EITHER --stale or --all — even --all's "clean
  // everything" intent presumes we know what "everything" currently is.
  // Excluded up front rather than relying on --stale's classification
  // filter to happen to omit it, so the refusal holds regardless of flag.
  const unreachable = rows.filter((r) => r.classification === "unreachable");
  if (unreachable.length > 0) {
    console.warn(
      `clean: skipped ${unreachable.length} session(s) whose container state is unreachable ` +
        `(gateway call failed, not confirmed absent): ${unreachable.map((r) => r.meta.name).join(", ")}`,
    );
  }
  const targets = rows.filter((r) => {
    if (r.classification === "unreachable") return false;
    return stale ? r.classification === "exited" || r.classification === "missing" : true;
  });
  for (const r of targets) {
    try {
      await clean(r.meta.name, { copyDir });
    } catch (e) {
      console.error(`clean ${r.meta.name}: ${(e as Error).message}`);
    }
  }
  console.log(`cleaned ${targets.length} session(s)`);
  return 0;
}

export async function cleanCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("clean", flagSchema, "[name]");
    return 0;
  }
  const copyDir = values.copy;
  if (values.all === true || values.stale === true) {
    return runBulkClean(values.stale === true, copyDir, REAL_BULK_CLEAN_DEPS);
  }
  const name = await resolveSessionName(positionals[0], "clean");
  if (!name) return 1;
  try {
    await cleanSession(name, { copyDir }, REAL_CLEAN_DEPS);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
