export type Harness = "claude_code" | "opencode";

export const HARNESSES: ReadonlySet<Harness> = new Set<Harness>(["claude_code", "opencode"]);

export function validateHarness(value: string, source: string): Harness {
  if (!HARNESSES.has(value as Harness)) {
    const allowed = [...HARNESSES].join(", ");
    throw new Error(
      `${source}: ${JSON.stringify(value)} is not a recognized harness. Allowed: ${allowed}`,
    );
  }
  return value as Harness;
}

export function harnessLaunchArgv(harness: Harness, args: readonly string[]): string[] {
  switch (harness) {
    case "claude_code":
      return ["claude", ...args];
    case "opencode":
      return ["opencode", ...args];
  }
}

export function harnessBinaryPath(harness: Harness): string {
  switch (harness) {
    case "claude_code":
      return "/usr/local/bin/claude";
    case "opencode":
      return "/usr/local/bin/opencode";
  }
}

export interface ResolveHarnessArgs {
  cliFlag: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /** Harness persisted in the project's .openlock/config.yaml, if any. Sits
   * below env (a per-shell override) and above the user-global default. */
  projectHarness?: Harness | undefined;
  readGlobal: () => { defaultHarness?: Harness } | null;
}

export function resolveHarness(args: ResolveHarnessArgs): Harness {
  if (args.cliFlag) return validateHarness(args.cliFlag, "--harness");
  const envVal = args.env.OPENLOCK_HARNESS;
  if (envVal) return validateHarness(envVal, "OPENLOCK_HARNESS");
  if (args.projectHarness) return args.projectHarness;
  const global = args.readGlobal();
  if (global?.defaultHarness) return global.defaultHarness;
  return "claude_code";
}

/** Harness options for an interactive picker, derived from HARNESSES (the
 * source of truth) so new harnesses surface everywhere automatically. */
export function harnessChoices(): { label: string; value: string }[] {
  return [...HARNESSES].map((h) => ({ label: h, value: h }));
}

/** Index of `defaultHarness` within harnessChoices(), or 0 if unset/unknown. */
export function harnessDefaultIndex(defaultHarness: Harness | undefined): number {
  if (defaultHarness === undefined) return 0;
  const i = [...HARNESSES].indexOf(defaultHarness);
  return i < 0 ? 0 : i;
}
