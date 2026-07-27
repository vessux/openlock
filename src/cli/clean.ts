import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import {
  type ClassifiedSession,
  type CleanOpts,
  classifyAll,
  cleanSession,
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
  /** Defaults to selfHealGatewayIfRuntimeConfigured. */
  selfHealGateway?: () => Promise<unknown>;
  /** Defaults to classifyAll. */
  classifyAll?: () => Promise<ClassifiedSession[]>;
  /** Defaults to cleanSession. */
  cleanSession?: (name: string, opts: CleanOpts) => Promise<void>;
}

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
  deps: BulkCleanDeps = {},
): Promise<number> {
  const selfHeal = deps.selfHealGateway ?? selfHealGatewayIfRuntimeConfigured;
  const classify = deps.classifyAll ?? classifyAll;
  const clean = deps.cleanSession ?? cleanSession;

  try {
    await selfHeal();
  } catch (e) {
    console.error(
      `clean: gateway is down and could not be started (${(e as Error).message}); nothing cleaned.`,
    );
    return 1;
  }

  const rows = await classify();
  const targets = rows.filter((r) =>
    stale ? r.classification === "exited" || r.classification === "missing" : true,
  );
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
    return runBulkClean(values.stale === true, copyDir);
  }
  const name = await resolveSessionName(positionals[0], "clean");
  if (!name) return 1;
  try {
    await cleanSession(name, { copyDir });
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
