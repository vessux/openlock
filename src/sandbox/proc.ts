export function pidAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
