import { createInterface } from "node:readline";

import type { SessionMeta } from "../sandbox/session-store";

export interface PickerIO {
  isTTY: boolean;
  readLine(): Promise<string | null>;
  writeStderr(s: string): void;
  detectFzf(): boolean;
  runFzf(input: string, prompt: string): Promise<string | null>;
}

export async function pickSession(
  sessions: SessionMeta[],
  action: string,
  io: PickerIO,
): Promise<SessionMeta | null> {
  if (sessions.length === 0) return null;
  if (!io.isTTY) return null;

  if (io.detectFzf()) {
    const input = sessions.map((s) => `${s.name}\t${s.repoPath}`).join("\n");
    const selected = await io.runFzf(input, action);
    if (selected === null) return null;
    const name = selected.split("\t")[0];
    return sessions.find((s) => s.name === name) ?? null;
  }

  return promptNumbered(sessions, action, io);
}

async function promptNumbered(
  sessions: SessionMeta[],
  action: string,
  io: PickerIO,
): Promise<SessionMeta | null> {
  const printList = (): void => {
    io.writeStderr(`Pick one for ${action}:\n`);
    sessions.forEach((s, i) => {
      io.writeStderr(`  ${i + 1}) ${s.name}  (${s.repoPath})\n`);
    });
    io.writeStderr("> ");
  };

  printList();
  let line = await io.readLine();
  let picked = parseChoice(line, sessions.length);
  if (picked === null && line !== null && line.trim() !== "") {
    printList();
    line = await io.readLine();
    picked = parseChoice(line, sessions.length);
  }
  if (picked === null) return null;
  return sessions[picked - 1] ?? null;
}

function parseChoice(line: string | null, max: number): number | null {
  if (line === null) return null;
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) return null;
  return n;
}

export function defaultPickerIO(): PickerIO {
  return {
    isTTY: process.stdin.isTTY === true,
    async readLine() {
      const rl = createInterface({ input: process.stdin });
      try {
        for await (const line of rl) return line;
        return null;
      } finally {
        rl.close();
      }
    },
    writeStderr(s) {
      process.stderr.write(s);
    },
    detectFzf() {
      const r = Bun.spawnSync({ cmd: ["which", "fzf"], stdout: "ignore", stderr: "ignore" });
      return r.exitCode === 0;
    },
    async runFzf(input, prompt) {
      const proc = Bun.spawn({
        cmd: ["fzf", `--prompt=${prompt} > `, "--no-sort", "--height=40%", "--reverse"],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      proc.stdin.write(input);
      proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) return null;
      const trimmed = out.replace(/\n$/, "");
      return trimmed.length > 0 ? trimmed : null;
    },
  };
}
