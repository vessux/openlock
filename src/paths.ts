import { join } from "node:path";

export function forkDir(): string {
  return join(import.meta.dir, "..", "openshell-fork");
}
