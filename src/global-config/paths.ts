import { homedir } from "node:os";
import { join } from "node:path";

export function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(process.env.HOME ?? homedir(), ".config");
  return join(base, "openlock", "config.yaml");
}
