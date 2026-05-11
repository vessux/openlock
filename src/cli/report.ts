import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import pkg from "../../package.json" with { type: "json" };
import { runDoctorChecks } from "../doctor";
import { OPENSHELL_FORK_TAG } from "../sandbox/fork-binaries";
import { printCmdHelp } from "./_help";
import { capLines, redactSecrets, stripSecretFields } from "./report-redact";

export const flagSchema = {
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const LOG_TAIL_LINES = 5000;
const CMD_TIMEOUT_MS = 2000;

interface SummaryVersions {
  openlock: string;
  openshellForkPin: string;
  podman: string | null;
  claudeCode: string | null;
  node: string;
  platform: string;
  arch: string;
}

interface SummarySession {
  id: string;
  stateFile: string;
  metadata: unknown;
}

interface SummaryLog {
  path: string;
  exists: boolean;
  originalBytes: number | null;
  linesIncluded: number | null;
  redactionCounts: Record<string, number> | null;
}

interface Summary {
  schemaVersion: 1;
  generatedAt: string;
  versions: SummaryVersions;
  doctor: Array<{ name: string; ok: boolean }>;
  sessions: SummarySession[];
  log: SummaryLog;
}

export interface ReportOptions {
  stateDir?: string;
  outDir?: string;
}

export async function report(
  opts: ReportOptions = {},
): Promise<{ path: string; doctorFailures: number }> {
  const stateDir =
    opts.stateDir ?? join(process.env.HOME || homedir(), ".local", "state", "openlock");
  const outDir = resolve(opts.outDir ?? process.cwd());

  const now = new Date();
  const timestamp = utcStamp(now);
  const bundleName = `openlock-report-${timestamp}`;
  const tarballPath = join(outDir, `${bundleName}.tar.gz`);

  const stageRoot = mkdtempSync(join(tmpdir(), "openlock-report-"));
  const bundleDir = join(stageRoot, bundleName);
  mkdirSync(bundleDir, { recursive: true });

  const [versions, doctor, sessions, logResult] = await Promise.all([
    collectVersions(),
    collectDoctor(),
    collectSessions(stateDir),
    collectLog(stateDir),
  ]);

  const doctorFailures = doctor.filter((d) => !d.ok).length;

  if (logResult.payload !== null) {
    writeFileSync(join(bundleDir, "gateway.log"), logResult.payload);
  }

  const summary: Summary = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    versions,
    doctor,
    sessions,
    log: logResult.info,
  };
  writeFileSync(join(bundleDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const tar = Bun.spawn(["tar", "-czf", tarballPath, "-C", stageRoot, bundleName], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await tar.exited;
  if (code !== 0) {
    const stderr = await new Response(tar.stderr).text();
    process.stderr.write(`openlock report: tar failed (exit ${code})\n${stderr}\n`);
    process.stderr.write(`Staging directory left in place: ${stageRoot}\n`);
    throw new Error(`tar exited with ${code}`);
  }

  rmSync(stageRoot, { recursive: true, force: true });
  return { path: tarballPath, doctorFailures };
}

export async function reportCmd(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("report", flagSchema, "");
    return 0;
  }
  try {
    const { path, doctorFailures } = await report();
    process.stdout.write(`${path}\n`);
    if (doctorFailures > 0) {
      process.stdout.write(
        `(${doctorFailures} doctor check${doctorFailures === 1 ? "" : "s"} failed — see summary.json)\n`,
      );
    }
    return 0;
  } catch {
    return 1;
  }
}

function utcStamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race<T | null>([
    p,
    new Promise<null>((res) => setTimeout(() => res(null), ms)),
  ]);
}

async function spawnVersion(argv: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const out = await withTimeout(
      (async () => {
        const code = await proc.exited;
        if (code !== 0) return null;
        return (await new Response(proc.stdout).text()).trim();
      })(),
      CMD_TIMEOUT_MS,
    );
    return out ?? null;
  } catch {
    return null;
  }
}

async function collectVersions(): Promise<SummaryVersions> {
  const [podman, claude] = await Promise.all([
    spawnVersion(["podman", "--version"]),
    spawnVersion(["claude", "--version"]),
  ]);
  return {
    openlock: pkg.version,
    openshellForkPin: OPENSHELL_FORK_TAG,
    podman,
    claudeCode: claude,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

async function collectDoctor(): Promise<Array<{ name: string; ok: boolean }>> {
  try {
    return await runDoctorChecks();
  } catch {
    return [];
  }
}

function collectSessions(stateDir: string): SummarySession[] {
  const sessionsDir = join(stateDir, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const out: SummarySession[] = [];
  for (const id of entries) {
    const stateFile = join(sessionsDir, id, "state.json");
    try {
      const raw = readFileSync(stateFile, "utf8");
      const parsed = JSON.parse(raw);
      out.push({ id, stateFile, metadata: stripSecretFields(parsed) });
    } catch {
      // Skip missing / unreadable / malformed entries.
    }
  }
  return out;
}

interface LogResult {
  payload: string | null;
  info: SummaryLog;
}

function collectLog(stateDir: string): LogResult {
  const path = join(stateDir, "gateway.log");
  try {
    const buf = readFileSync(path);
    const tail = capLines(buf.toString("utf8"), LOG_TAIL_LINES);
    const { text, counts } = redactSecrets(tail);
    return {
      payload: text,
      info: {
        path,
        exists: true,
        originalBytes: buf.length,
        linesIncluded: countLines(text),
        redactionCounts: counts,
      },
    };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
    return {
      payload: null,
      info: {
        path,
        exists: !missing,
        originalBytes: null,
        linesIncluded: null,
        redactionCounts: null,
      },
    };
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}
