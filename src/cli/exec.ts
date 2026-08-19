import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import {
  buildSandboxEnv,
  getSandboxState,
  harnessEnvFor,
  execCmd as runExec,
} from "../sandbox/container";
import { resolveRepoPolicy } from "../sandbox/session";
import { loadSessionByName } from "../sandbox/session-ops";
import type { SessionMeta } from "../sandbox/session-store";
import { printCmdHelp } from "./_help";
import { resolveSessionName } from "./_resolve";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

// openlock-xz6d: `.openlock/config.yaml`'s `env:` block is deliberately NOT a
// cold build input (see sandbox/drift.ts's doc comment on
// computeBuildInputsHash: "args/env/credentials... are re-applied on every
// attach and so never require a rebuild") — the attach path always
// re-resolves it fresh from whatever's on disk right now, and exec must match
// that same freshness contract rather than recording a create-time snapshot.
// Unlike `providerId` (recorded — see SessionMeta's doc comment), recomputing
// this is exactly what attach already does, so recomputing it here can't
// drift exec and attach apart.
//
// Two distinct failure shapes, deliberately NOT collapsed into one silent
// fallback:
//
// - Genuinely absent (no `.openlock/` directory at all — the project dir may
//   have been deleted/relocated since the sandbox was created, or this
//   session's project never had one). The sandbox outlives the project dir by
//   design; degrading SILENTLY here is legitimate and matches this file's
//   existing `meta === null` TOCTOU fallback below.
// - Present but unusable (`.openlock/` exists, but `resolveRepoPolicy` throws
//   — malformed `config.yaml`, an incomplete folder missing policy.yaml/
//   Containerfile, or an unreadable file). The ATTACH path treats this exact
//   failure LOUDLY: `runSandbox`'s own `resolveRepoPolicy` call
//   (session.ts) is wrapped in a try/catch that prints the error and
//   `process.exit(2)`s — it never silently proceeds with an empty env. A
//   silent degrade here would therefore manufacture a NEW exec-vs-attach
//   disagreement of the exact family this whole fix exists to eliminate: a
//   user's declared `env:` block silently not applied while the command
//   still runs and exits 0, indistinguishable from "nothing was declared".
//   Still degrades rather than erroring (exec runs against an
//   already-running sandbox and must stay usable mid-incident — same
//   reasoning as the `meta === null` fallback), but warns loudly first,
//   naming the project path and including the underlying error so a user
//   debugging a missing env var can tell "parse failure" apart from
//   "nothing declared".
//
// `resolveRepoPolicy` with no policy override reads the SAME `.openlock/`
// folder the attach path reads for a plain reattach (session.ts's
// `resolveRepoPolicy(projectPath, opts.policy)` with `opts.policy` here
// always absent, since `exec` has no `--policy` flag of its own — it only
// ever runs against an existing session).
function resolveRepoConfigEnvSafely(repoPath: string): Record<string, string> {
  if (!existsSync(join(repoPath, ".openlock"))) {
    return {};
  }
  try {
    return resolveRepoPolicy(repoPath).env;
  } catch (e) {
    console.warn(
      `openlock: could not read .openlock/config.yaml at ${repoPath} — its env: block was NOT ` +
        `applied to this exec: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}

// openlock-xz6d: mirrors buildSandboxEnv's exact merge order/precedence
// (placeholders < harnessEnv < repoConfigEnv) so exec and attach can't drift
// apart on which wins — see container.ts's buildSandboxEnv. Only branches
// away from calling buildSandboxEnv directly when `providerId` is unknown
// (a legacy session recorded before openlock-xz6d): buildSandboxEnv requires
// a real ProviderId, and guessing one here could silently stage the WRONG
// provider's placeholder for a session actually attached to a different
// provider — recorded-absent must inject NO placeholders, exactly today's
// (buggy) behavior, never a guess.
export function buildExecEnv(meta: SessionMeta): Record<string, string> {
  const repoConfigEnv = resolveRepoConfigEnvSafely(meta.repoPath);
  if (meta.providerId === undefined) {
    return { ...harnessEnvFor(meta.harness), ...repoConfigEnv };
  }
  return buildSandboxEnv({ providerId: meta.providerId, harness: meta.harness, repoConfigEnv });
}

export async function execCmd(args: string[]): Promise<number> {
  const dashIdx = args.indexOf("--");
  const before = dashIdx === -1 ? args : args.slice(0, dashIdx);
  const after = dashIdx === -1 ? [] : args.slice(dashIdx + 1);
  const { values, positionals } = parseArgs({
    args: before,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp("exec", flagSchema, "[name] -- <cmd...>");
    return 0;
  }
  if (after.length === 0) {
    console.error("usage: openlock exec [name] -- <cmd...>");
    return 1;
  }
  const name = await resolveSessionName(positionals[0], "exec into");
  if (!name) return 1;
  const state = await getSandboxState(name);
  if (state === "missing") {
    console.error(`session ${name} has no container`);
    return 1;
  }
  // openlock-04x / openlock-xz6d: without buildExecEnv, `openlock exec <s> --
  // <cmd>` ran with NO (openlock-04x) or PARTIAL (openlock-xz6d — harness env
  // only, missing provider placeholders and the config.yaml `env:` block)
  // env injection, unlike the attach path (buildSandboxEnv/execHarness),
  // which always gets the full set. buildExecEnv/buildSandboxEnv are the
  // single functions both paths call, so they can't drift apart again.
  // loadSessionByName can return null only on a narrow TOCTOU (session
  // deleted between resolveSessionName and here); fall back to no extra env
  // rather than failing the exec outright — the underlying `openshell
  // sandbox exec` call below will surface the real error anyway.
  const meta = await loadSessionByName(name);
  const env = meta ? buildExecEnv(meta) : {};
  return await runExec(name, after, env);
}
