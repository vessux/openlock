import { join } from "node:path";
import { resolveConfigDir } from "../paths";

export function globalConfigPath(): string {
  return join(resolveConfigDir(), "config.yaml");
}
