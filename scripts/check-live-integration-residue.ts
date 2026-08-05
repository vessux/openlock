// CI-only helper for the live-integration job's post-test residue check
// (bd openlock-n73d). Invoked from the "Assert gateway is clean" step in
// .github/workflows/test.yml, after the "Integration tests" step.
//
// WHY THIS EXISTS: openlock-18c (PR #144) fixed the live-integration suite's
// resource leak (per-file teardown registry + unconditional `afterAll` +
// a wait for the async `sandbox delete`), but nothing asserted the fix
// keeps working. CI cannot catch a regression on its own: every CI run
// starts from a FRESH gateway, so a leak is invisible there — it only
// resurfaces as a SECOND run sharing gateway state failing with confusing
// "provider already exists" / "attached to sandbox(es)" errors, which is
// exactly how it was originally misread as a product defect rather than a
// test-teardown bug. This script converts that invisible regression into an
// explicit, always-checked, red CI step.
//
// PREFIX-SCOPED AND READ-ONLY — NOT A SWEEP. This only lists and reports;
// it never deletes anything, on purpose. openlock-18c deliberately rejected
// a prefix-based delete sweep because this exact suite is also run locally
// against a developer's real dev gateway, which holds their real
// credential provider — a prior incident destroyed exactly that. An
// assertion step that also deletes on match is a sweep with a different
// name, so this script only ever fails loudly and lets a human (or the
// suite's own teardown) do the deleting.
//
// PREFIXES ARE DERIVED FROM THE SUITE ITSELF, not invented. As of
// openlock-18c, the suite has no shared teardown helper — the
// registry+afterAll pattern is duplicated inline across all 6 files it
// touches — so the prefixes below were found by reading all 6:
//   tests/integration/harness-binary-cred-inject.test.ts   -> sandbox `ol-hb-<ts36>`,       provider "openlock-test-hb-claude"
//   tests/integration/harness-cred-inject.test.ts          -> sandbox `ol-echo-<ts36>`,     provider "openlock-test-echo"
//   tests/integration/npm-scoped-pkg.test.ts                -> sandbox `ol-npm-<ts36>`,      (creates no provider)
//   tests/integration/openrouter-opencode-cred-inject.test.ts -> sandbox `ol-or-<ts36>`,     provider "openlock-test-openrouter"
//   tests/integration/post-create-exec-proxy.test.ts        -> sandbox `ol-hnp-<ts36>`,      provider "openlock-test-hnp"
//   tests/integration/post-create-openrouter-real.test.ts   -> sandbox `ol-orr-<ts36>`,      provider "openlock-test-or-real"
// Every sandbox session name across all 6 files starts with `ol-`; every
// provider name across the 5 that create one starts with `openlock-test-`.
// Both happen to be single clean prefixes — if a future file breaks that
// pattern, widen these constants rather than special-casing around them.
//
// CLI RESOLUTION: this job runs in PROD mode (the workflow does `bun
// install` only — it never checks out the gitignored openshell-fork/
// directory that dev mode depends on), so `getCliInvocation()` resolves
// the downloaded release binary, not the dev-mode `mise exec -- openshell`.
// Reuse the product's own resolver rather than re-deriving that logic here;
// see src/sandbox/fork-binaries.ts.
//
// OUTPUT FORMAT: `sandbox list --output json` / `provider list --output
// json` print a plain JSON array (see openshell-cli's
// print_output_collection) of objects each carrying a `name` field
// (sandbox_to_json / provider_to_json in run.rs) — never parse the
// colorized human table.
import { getCliInvocation } from "../src/sandbox/fork-binaries";

const SANDBOX_PREFIX = "ol-";
const PROVIDER_PREFIX = "openlock-test-";

interface ListedResource {
  name?: unknown;
}

/** Run `openshell <subcommand> list --output json` and return the parsed array. */
async function listJson(subcommand: "sandbox" | "provider"): Promise<ListedResource[]> {
  const cli = await getCliInvocation();
  const proc = Bun.spawn([...cli.argv, subcommand, "list", "--output", "json"], {
    cwd: cli.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `openshell ${subcommand} list --output json failed (exit ${exitCode}): ${stderr || stdout}`,
    );
  }
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error(`openshell ${subcommand} list --output json did not return a JSON array: ${stdout}`);
  }
  return parsed as ListedResource[];
}

function namesWithPrefix(resources: ListedResource[], prefix: string): string[] {
  return resources
    .map((r) => (typeof r.name === "string" ? r.name : null))
    .filter((name): name is string => name !== null && name.startsWith(prefix));
}

async function main(): Promise<void> {
  const [sandboxes, providers] = await Promise.all([listJson("sandbox"), listJson("provider")]);

  const leakedSandboxes = namesWithPrefix(sandboxes, SANDBOX_PREFIX);
  const leakedProviders = namesWithPrefix(providers, PROVIDER_PREFIX);

  if (leakedSandboxes.length === 0 && leakedProviders.length === 0) {
    console.log(
      `openlock-n73d: gateway clean — no sandboxes matching "${SANDBOX_PREFIX}*" or providers matching "${PROVIDER_PREFIX}*" remain.`,
    );
    return;
  }

  console.error(
    "openlock-n73d: the live-integration suite left residue in the gateway. This means a " +
      "teardown regressed (see openlock-18c / PR #144) — a real run's afterAll should have " +
      "removed these:",
  );
  if (leakedSandboxes.length > 0) {
    console.error(`  sandboxes matching "${SANDBOX_PREFIX}*": ${leakedSandboxes.join(", ")}`);
  }
  if (leakedProviders.length > 0) {
    console.error(`  providers matching "${PROVIDER_PREFIX}*": ${leakedProviders.join(", ")}`);
  }
  console.error(
    "This check is deliberately read-only (bd openlock-n73d) — it does not delete anything. " +
      "Investigate and clean up manually if this is a real dev gateway.",
  );
  process.exit(1);
}

await main();
