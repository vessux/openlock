// SSH death-rattle: at session detach, openshell's SSH child dies and prints
// these in sequence. Each pattern is unconditionally noise; we drop them.
//   "Connection to <host> closed by remote host."   ← OpenSSH client
//   "client_loop: send disconnect: Broken pipe"     ← OpenSSH client
//   "Error:   × ssh exited with status exit status: 255"  ← openshell miette
// Older openshell builds split miette across two lines (bare "Error:" header,
// then "  × ssh exited with status 255" body, optional "  ╰─▶ ..." continuation).
// We tolerate both formats. Exit code stays pinned to 255 so any other ssh
// failure (auth, host key, etc.) still surfaces.
const SSH_EXIT = /ssh exited with status (?:exit status: )?255\b/;
const SSH_CONN_CLOSED = /^\s*Connection to .+ closed by remote host\.?\s*$/;
const SSH_CLIENT_LOOP = /^\s*client_loop:\s/;
const MIETTE_HEADER = /^\s*Error:\s*$/;
const MIETTE_CONTINUATION = /^\s+(?:╰─▶|╭─|help:|×|◇)/u;

function isNoiseLine(line: string): boolean {
  return SSH_EXIT.test(line) || SSH_CONN_CLOSED.test(line) || SSH_CLIENT_LOOP.test(line);
}

export function shouldDropOpenshellStderrLine(line: string): boolean {
  return isNoiseLine(line);
}

/**
 * Filter stderr from `openshell sandbox create`. Drops the SSH death-rattle
 * block at session detach (3 lines on current openshell, plus a bare `Error:`
 * header on older builds). Preserves trailing partial line so callers can
 * buffer across reads. Pure.
 */
export function filterOpenshellStderr(input: string): string {
  const endsWithNewline = input.endsWith("\n");
  const lines = input.split("\n");
  const tail = endsWithNewline ? "" : lines.pop()!;
  const completeLines = endsWithNewline ? lines.slice(0, -1) : lines;

  const kept: { idx: number; line: string }[] = [];
  const drop = new Set<number>();
  for (let i = 0; i < completeLines.length; i++) {
    const line = completeLines[i]!;
    if (isNoiseLine(line)) {
      drop.add(i);
      // Drop preceding bare `Error:` miette header if it's the previous kept line.
      const j = kept.length - 1;
      if (j >= 0 && MIETTE_HEADER.test(kept[j]!.line)) {
        drop.add(kept[j]!.idx);
        kept.splice(j, 1);
      }
      continue;
    }
    if (drop.has(i - 1) && MIETTE_CONTINUATION.test(line)) {
      drop.add(i);
      continue;
    }
    kept.push({ idx: i, line });
  }

  const output = kept.map((k) => k.line).join("\n");
  if (kept.length === 0) return tail;
  return endsWithNewline ? `${output}\n${tail}` : output + (tail ? `\n${tail}` : "");
}
