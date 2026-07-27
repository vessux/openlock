export function newSessionId(): string {
  return Bun.randomUUIDv7();
}

// The gateway caps DNS-routable names (workspace, sandbox, service) at 19
// characters: three segments plus two `--` delimiters must fit inside a 63-char
// DNS label (19 + 2 + 19 + 2 + 19 = 61). A longer sandbox name is rejected with
// `InvalidArgument: name exceeds maximum length (N > 19)`. This arrived with
// upstream's workspace resource model and was absorbed in the v0.8.0 fork sync;
// before that the effective ceiling was 253, so any directory name worked.
const MAX_ROUTABLE_NAME_LEN = 19;
// Trailing hex from the session id, disambiguating sessions that share a
// project directory name.
const ID_SUFFIX_LEN = 6;

export function friendlyNameFromId(basename: string, id: string): string {
  const sanitized = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = sanitized.length > 0 ? sanitized : "sandbox";
  const suffix = id.replace(/-/g, "").slice(-ID_SUFFIX_LEN);
  // Budget the project segment so `<segment>-<suffix>` fits the routable cap.
  // Truncating can expose a trailing hyphen (`my-web-serv-` from
  // `my-web-server-api`), which is not a canonical DNS label, so strip those;
  // fall back to "sandbox" if nothing printable survives.
  const budget = MAX_ROUTABLE_NAME_LEN - suffix.length - 1;
  const segment = safe.slice(0, budget).replace(/-+$/g, "") || "sandbox";
  return `${segment}-${suffix}`;
}
