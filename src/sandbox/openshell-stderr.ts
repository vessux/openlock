const SSH_255 = /ssh exited with status 255/;
const MIETTE_HEADER = /^\s*Error:\s*$/;
const MIETTE_CONTINUATION = /^\s+(?:╰─▶|╭─|help:|×|◇)/u;

export function shouldDropOpenshellStderrLine(line: string): boolean {
  return SSH_255.test(line);
}

/**
 * Filter stderr from `openshell sandbox create`. Drops the noisy
 * "ssh exited with status 255" line emitted on Linux when `gateway stop`
 * severs the create child's SSH proxy at session end, plus any directly
 * adjacent miette report decoration (the surrounding `Error:` / `╰─▶` lines).
 *
 * Pure: input → output. Trailing partial line (no final \n) is preserved
 * unfiltered so callers can buffer across reads.
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
    if (SSH_255.test(line)) {
      drop.add(i);
      // Drop preceding `Error:` header if it's the previous non-dropped line.
      for (let j = kept.length - 1; j >= 0; j--) {
        const prev = kept[j]!;
        if (MIETTE_HEADER.test(prev.line)) {
          drop.add(prev.idx);
          kept.splice(j, 1);
        }
        break;
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
