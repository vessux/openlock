import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { promoteActiveBranch } from "../sandbox/git-sync";
import { listAllSessions, type SessionMeta, sessionsDir } from "../sandbox/session-store";
import { printCmdHelp } from "./_help";
import { defaultPickerIO, pickItem } from "./_picker";

export const flagSchema = {
  json: { type: "boolean" },
  force: { type: "boolean" },
  "branch-name": { type: "string", short: "b" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export interface RefsDeps {
  listSessions: () => SessionMeta[];
  log: (line: string) => void;
  err?: (line: string) => void;
  // For Task 5 (promote with picker).
  pick?: <T>(items: T[], render: (item: T) => string) => Promise<T | null>;
}

const defaultDeps = (): RefsDeps => ({
  listSessions: () => listAllSessions(sessionsDir()),
  log: (s) => console.log(s),
  err: (s) => console.error(s),
  pick: (items, render) =>
    pickItem(
      items,
      {
        numbered: render,
        fzfLine: render,
        fzfMatch: (line, all) => all.find((it) => render(it) === line) ?? null,
      },
      "promote",
      defaultPickerIO(),
    ),
});

interface RefRow {
  session: string;
  branch: string;
  ahead: number;
  promoted: string | null;
  commit: string;
}

async function captureStdout(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

async function readPromotedOid(meta: SessionMeta): Promise<string> {
  const promotedRef = `refs/heads/openlock/${meta.name}`;
  const res = await captureStdout(
    ["git", "rev-parse", "--verify", `${promotedRef}^{commit}`],
    meta.repoPath,
  );
  return res.exitCode === 0 ? res.stdout.trim() : "";
}

async function countAhead(
  repoPath: string,
  refName: string,
  hostBranch: string,
): Promise<number | null> {
  // ahead = commits in sandbox not in host counterpart. If host counterpart
  // is missing, treat as commits-from-root.
  const hostCheck = await captureStdout(
    ["git", "rev-parse", "--verify", `${hostBranch}^{commit}`],
    repoPath,
  );
  const aheadRange = hostCheck.exitCode === 0 ? `${hostBranch}..${refName}` : refName;
  const aheadRes = await captureStdout(["git", "rev-list", "--count", aheadRange], repoPath);
  if (aheadRes.exitCode !== 0) return null;
  const ahead = Number.parseInt(aheadRes.stdout.trim(), 10);
  return Number.isFinite(ahead) ? ahead : null;
}

async function buildRow(
  meta: SessionMeta,
  refName: string,
  fullOid: string,
  promotedOid: string,
  prefix: string,
): Promise<RefRow | null> {
  const branch = refName.slice(prefix.length);
  const ahead = await countAhead(meta.repoPath, refName, `refs/heads/${branch}`);
  if (ahead === null || ahead === 0) return null;
  const promoted = fullOid === promotedOid ? `openlock/${meta.name}` : null;
  return {
    session: meta.name,
    branch,
    ahead,
    promoted,
    commit: fullOid.slice(0, 7),
  };
}

async function gatherRows(meta: SessionMeta): Promise<RefRow[]> {
  const prefix = `refs/sandbox/${meta.name}/`;
  const { exitCode, stdout } = await captureStdout(
    ["git", "for-each-ref", "--format=%(refname) %(objectname)", prefix],
    meta.repoPath,
  );
  if (exitCode !== 0 || stdout.trim() === "") return [];

  const promotedOid = await readPromotedOid(meta);
  const rows: RefRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [refName, fullOid] = trimmed.split(/\s+/);
    if (refName === undefined || fullOid === undefined) continue;
    if (!refName.startsWith(prefix)) continue;
    const row = await buildRow(meta, refName, fullOid, promotedOid, prefix);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function renderTable(rows: RefRow[], log: (line: string) => void): void {
  const headers = ["SESSION", "BRANCH", "AHEAD", "PROMOTED", "COMMIT"];
  const widths = headers.map((h) => h.length);
  const cells = rows.map((r) => [
    r.session,
    r.branch,
    String(r.ahead),
    r.promoted ?? "—",
    r.commit,
  ]);
  for (const row of cells) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (cell !== undefined && cell.length > (widths[i] ?? 0)) widths[i] = cell.length;
    }
  }
  const fmt = (row: string[]): string =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  log(fmt(headers));
  for (const row of cells) log(fmt(row));
}

function selectSessions(
  sessions: SessionMeta[],
  filter: string | undefined,
  deps: RefsDeps,
): SessionMeta[] | null {
  if (filter === undefined) return sessions;
  const filtered = sessions.filter((s) => s.name === filter);
  if (filtered.length === 0) {
    (deps.err ?? deps.log)(`Session "${filter}" not found.`);
    return null;
  }
  return filtered;
}

async function listAction(positionals: string[], json: boolean, deps: RefsDeps): Promise<number> {
  const filtered = selectSessions(deps.listSessions(), positionals[0], deps);
  if (filtered === null) return 1;

  const rows: RefRow[] = [];
  for (const meta of filtered) {
    rows.push(...(await gatherRows(meta)));
  }

  if (json) {
    deps.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    deps.log("No sandbox commits to promote.");
    return 0;
  }
  renderTable(rows, deps.log);
  return 0;
}

interface Candidate {
  session: string;
  branch: string;
  ahead: number;
  commit: string;
  meta: SessionMeta;
}

async function gatherCandidates(sessions: SessionMeta[]): Promise<Candidate[]> {
  const all: Candidate[] = [];
  for (const meta of sessions) {
    const rows = await gatherRows(meta);
    for (const row of rows) {
      all.push({
        session: row.session,
        branch: row.branch,
        ahead: row.ahead,
        commit: row.commit,
        meta,
      });
    }
  }
  return all;
}

async function resolveCandidate(
  filtered: Candidate[],
  sessionArg: string | undefined,
  branchArg: string | undefined,
  deps: RefsDeps,
): Promise<Candidate | null> {
  if (branchArg !== undefined && sessionArg !== undefined) {
    const direct = filtered.find((c) => c.branch === branchArg) ?? null;
    if (direct === null) {
      (deps.err ?? deps.log)(`Branch "${branchArg}" not found in session "${sessionArg}".`);
    }
    return direct;
  }
  if (filtered.length === 1) return filtered[0] ?? null;
  if (deps.pick === undefined) {
    (deps.err ?? deps.log)("Multiple candidates; picker not available in this environment.");
    return null;
  }
  const chosen = await deps.pick(
    filtered,
    (c) => `${c.session}  ${c.branch}  (+${c.ahead} commits, ${c.commit})`,
  );
  if (chosen === null) {
    (deps.err ?? deps.log)("No selection.");
  }
  return chosen;
}

async function promoteAction(
  positionals: string[],
  values: { force?: boolean | undefined; "branch-name"?: string | undefined },
  deps: RefsDeps,
): Promise<number> {
  const sessions = deps.listSessions();
  const sessionArg = positionals[0];
  const branchArg = positionals[1];

  const allCandidates = await gatherCandidates(sessions);

  let filtered = allCandidates;
  if (sessionArg !== undefined) {
    filtered = allCandidates.filter((c) => c.session === sessionArg);
    if (filtered.length === 0) {
      const known = sessions.some((s) => s.name === sessionArg);
      const msg = known
        ? `Session "${sessionArg}" has no commits to promote.`
        : `Session "${sessionArg}" not found.`;
      (deps.err ?? deps.log)(msg);
      return 1;
    }
  }

  if (filtered.length === 0) {
    (deps.err ?? deps.log)("No sandbox commits to promote.");
    return 1;
  }

  const chosen = await resolveCandidate(filtered, sessionArg, branchArg, deps);
  if (chosen === null) return 1;

  const result = await promoteActiveBranch(chosen.meta.repoPath, chosen.session, chosen.branch, {
    force: values.force === true,
    targetName: values["branch-name"],
  });

  const targetShort = result.target.replace("refs/heads/", "");
  switch (result.outcome) {
    case "created":
      deps.log(`Promoted to ${targetShort}`);
      return 0;
    case "fast-forwarded":
      deps.log(`Fast-forwarded ${targetShort}`);
      return 0;
    case "skipped":
      deps.log(`${targetShort} already at this commit; nothing to do.`);
      return 0;
    case "diverged":
      (deps.err ?? deps.log)(
        `${targetShort} has diverged from sandbox. Use --force to overwrite, or pass -b <name> to use a different target name.`,
      );
      return 1;
  }
}

export async function refsCmd(args: string[], deps: RefsDeps = defaultDeps()): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printCmdHelp(
      "refs",
      flagSchema,
      "<list|promote> [<session>] [<branch>]",
      "Inspect and promote sandbox commits to real branches",
    );
    return args.length === 0 ? 1 : 0;
  }
  const subverb = args[0];
  const subArgs = args.slice(1);
  const { values, positionals } = parseArgs({
    args: subArgs,
    options: flagSchema,
    allowPositionals: true,
  });
  if (values.help === true) {
    printCmdHelp(
      "refs",
      flagSchema,
      "<list|promote> [<session>] [<branch>]",
      "Inspect and promote sandbox commits to real branches",
    );
    return 0;
  }
  switch (subverb) {
    case "list":
      return listAction(positionals, values.json === true, deps);
    case "promote":
      return promoteAction(positionals, values, deps);
    default:
      (deps.err ?? deps.log)(`Unknown refs subcommand: ${subverb}`);
      return 1;
  }
}
