export function newSessionId(): string {
  return Bun.randomUUIDv7();
}

export function friendlyNameFromId(basename: string, id: string): string {
  const sanitized = basename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const safe = sanitized.length > 0 ? sanitized : "sandbox";
  const suffix = id.replace(/-/g, "").slice(-6);
  return `${safe}-${suffix}`;
}
