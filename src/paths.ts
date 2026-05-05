import { join } from "path";

export function forkDir(): string {
  return join(import.meta.dir, "..", "openshell-fork");
}
