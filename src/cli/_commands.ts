import type { ParseArgsOptionsConfig } from "node:util";
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
import { flagSchema as providersFlags } from "./providers";
import { flagSchema as reapFlags } from "./reap";
import { flagSchema as refsFlags } from "./refs";
import { flagSchema as reportFlags } from "./report";
import { flagSchema as sandboxFlags } from "./sandbox";
import { flagSchema as shellFlags } from "./shell";
import { flagSchema as statusFlags } from "./status";
import { flagSchema as stopFlags } from "./stop";
import { flagSchema as updateImagesFlags } from "./update-images";
import { flagSchema as validateFlags } from "./validate";

export const COMMAND_FLAGS = {
  init: initFlags,
  sandbox: sandboxFlags,
  list: listFlags,
  status: statusFlags,
  stop: stopFlags,
  clean: cleanFlags,
  reap: reapFlags,
  shell: shellFlags,
  exec: execFlags,
  "cred-refresh": credRefreshFlags,
  login: loginFlags,
  logout: logoutFlags,
  providers: providersFlags,
  gateway: gatewayFlags,
  doctor: doctorFlags,
  "update-images": updateImagesFlags,
  complete: completeFlags,
  refs: refsFlags,
  report: reportFlags,
  validate: validateFlags,
} as const satisfies Record<string, ParseArgsOptionsConfig>;

export type CommandName = keyof typeof COMMAND_FLAGS;

export const SESSION_COMMANDS = ["status", "stop", "clean", "shell", "exec"] as const;

// Re-export descriptions from the cycle-safe source file so callers that
// already import from _commands.ts can pick them up here too.
export { COMMAND_DESCRIPTIONS } from "./_descriptions";
