import { createInterface } from "node:readline";

import { commandExists } from "../command-exists";
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
  return pickItem(
    sessions,
    {
      numbered: (s) => `${s.name}  (${s.repoPath})`,
      fzfLine: (s) => `${s.name}\t${s.repoPath}`,
      fzfMatch: (line, items) => {
        const name = line.split("\t")[0];
        return items.find((s) => s.name === name) ?? null;
      },
    },
    action,
    io,
  );
}

export interface PickRender<T> {
  /** Label for the numbered fallback (shown in the prompt list). */
  numbered: (item: T) => string;
  /** One-line representation passed to fzf as input. */
  fzfLine: (item: T) => string;
  /** Resolve fzf's selected output line back to an item. */
  fzfMatch: (line: string, items: T[]) => T | null;
}

export async function pickItem<T>(
  items: T[],
  render: PickRender<T>,
  action: string,
  io: PickerIO,
): Promise<T | null> {
  if (items.length === 0) return null;
  if (!io.isTTY) return null;

  if (io.detectFzf()) {
    const input = items.map(render.fzfLine).join("\n");
    const selected = await io.runFzf(input, action);
    if (selected === null) return null;
    return render.fzfMatch(selected, items);
  }

  return promptNumbered(items, render.numbered, action, io);
}

async function promptNumbered<T>(
  items: T[],
  label: (item: T) => string,
  action: string,
  io: PickerIO,
): Promise<T | null> {
  const printList = (): void => {
    io.writeStderr(`Pick one for ${action}:\n`);
    items.forEach((item, i) => {
      io.writeStderr(`  ${i + 1}) ${label(item)}\n`);
    });
    io.writeStderr("> ");
  };

  printList();
  let line = await io.readLine();
  let picked = parseChoice(line, items.length);
  if (picked === null && line !== null && line.trim() !== "") {
    printList();
    line = await io.readLine();
    picked = parseChoice(line, items.length);
  }
  if (picked === null) return null;
  return items[picked - 1] ?? null;
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
      return commandExists("fzf");
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
