/** Sum the available subordinate-id count for `user` across all ranges in an /etc/subuid|subgid file body. */
export function parseSubidCount(fileContent: string, user: string): number {
  let total = 0;
  for (const line of fileContent.split("\n")) {
    const parts = line.split(":");
    if (parts.length !== 3) continue;
    if (parts[0] !== user) continue;
    const count = Number.parseInt(parts[2], 10);
    if (Number.isFinite(count)) total += count;
  }
  return total;
}

/** keep-id:uid=N needs the range to represent container uid N → count must exceed N. */
export function rangeCoversUid(subuidContent: string, user: string, uid: number): boolean {
  return parseSubidCount(subuidContent, user) > uid;
}
