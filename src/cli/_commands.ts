import type { ParseArgsOptionsConfig } from "node:util";
import { COMMAND_DESCRIPTIONS, type CommandName as DescriptionCommandName } from "./_descriptions";
import { flagSchema as cleanFlags } from "./clean";
import { flagSchema as completeFlags } from "./complete";
import { flagSchema as credRefreshFlags } from "./cred-refresh";
import { flagSchema as doctorFlags } from "./doctor";
import { flagSchema as execFlags } from "./exec";
import { flagSchema as gatewayFlags } from "./gateway";
import { flagSchema as initFlags } from "./init";
import { flagSchema as listFlags } from "./list";
import { flagSchema as loginFlags } from "./login";
import { flagSchema as logoutFlags } from "./logout";
import { flagSchema as logsFlags } from "./logs";
import { flagSchema as providersFlags } from "./providers";
import { flagSchema as pruneImagesFlags } from "./prune-images";
import { flagSchema as reapFlags } from "./reap";
import { flagSchema as refsFlags } from "./refs";
import { flagSchema as reportFlags } from "./report";
import { flagSchema as sandboxFlags } from "./sandbox";
import { flagSchema as setupFlags } from "./setup";
import { flagSchema as shellFlags } from "./shell";
import { flagSchema as statusFlags } from "./status";
import { flagSchema as stopFlags } from "./stop";
import { flagSchema as updateBaseFlags } from "./update-base";
import { flagSchema as updateHarnessFlags } from "./update-harness";
import { flagSchema as updateImagesFlags } from "./update-images";
import { flagSchema as validateFlags } from "./validate";

export const COMMAND_FLAGS = {
  init: initFlags,
  setup: setupFlags,
  sandbox: sandboxFlags,
  list: listFlags,
  status: statusFlags,
  stop: stopFlags,
  clean: cleanFlags,
  reap: reapFlags,
  shell: shellFlags,
  exec: execFlags,
  logs: logsFlags,
  "cred-refresh": credRefreshFlags,
  login: loginFlags,
  logout: logoutFlags,
  providers: providersFlags,
  gateway: gatewayFlags,
  doctor: doctorFlags,
  "update-images": updateImagesFlags,
  "update-base": updateBaseFlags,
  "update-harness": updateHarnessFlags,
  "prune-images": pruneImagesFlags,
  complete: completeFlags,
  refs: refsFlags,
  report: reportFlags,
  validate: validateFlags,
  // The `satisfies Record<DescriptionCommandName, ...>` constraint (rather
  // than `Record<string, ...>`) is load-bearing: `_descriptions.ts` has no
  // upward imports specifically so it can be depended on here without a
  // cycle, and doing so turns "COMMAND_FLAGS is missing a command that has
  // a description" (openlock-tuxj's drift, one direction of it) into a
  // compile error instead of a silent gap. The other direction — a flags
  // entry with no matching description — isn't caught by this constraint
  // (Record<K,V> doesn't forbid extra literal keys), so it's covered
  // instead by the runtime equality assertion in _commands.test.ts.
} as const satisfies Record<DescriptionCommandName, ParseArgsOptionsConfig>;

export type CommandName = keyof typeof COMMAND_FLAGS;

export const SESSION_COMMANDS = ["status", "stop", "clean", "shell", "exec", "logs"] as const;

// Re-export so callers that already import from _commands.ts can pick up
// descriptions here too (COMMAND_DESCRIPTIONS itself is imported above,
// alongside its CommandName, to build the compile-time constraint on
// COMMAND_FLAGS).
export { COMMAND_DESCRIPTIONS };
