/**
 * True if `cmd` is resolvable on PATH.
 *
 * Uses Bun.which (a direct PATH search, no subprocess) rather than shelling out
 * to `which`, which is not installed by default on some distros (e.g. Fedora 43)
 * and made doctor + runtime auto-detection report installed tools as missing.
 */
export function commandExists(cmd: string): boolean {
  return Bun.which(cmd) !== null;
}
