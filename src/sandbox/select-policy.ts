import { join } from "path";
import type { Cap } from "./detect-caps";

const PROJECT_ROOT = join(import.meta.dir, "../..");

export function selectPolicy(caps: Cap[]): string {
  const suffix = caps.length > 0 ? `-${caps.join("-")}` : "";
  return join(PROJECT_ROOT, "policies", `default${suffix}.yaml`);
}
