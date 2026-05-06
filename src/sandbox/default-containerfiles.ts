import core from "../../containers/core.Containerfile" with { type: "text" };
import coreJs from "../../containers/core-js.Containerfile" with { type: "text" };
import corePy from "../../containers/core-py.Containerfile" with { type: "text" };
import coreJsPy from "../../containers/core-js-py.Containerfile" with { type: "text" };

import type { Cap } from "./detect-caps";

export type ContainerfileKey = "core" | "core-js" | "core-py" | "core-js-py";

export const DEFAULT_CONTAINERFILES: Record<ContainerfileKey, string> = {
  "core": core,
  "core-js": coreJs,
  "core-py": corePy,
  "core-js-py": coreJsPy,
};

export function containerfileKeyForCaps(caps: Cap[]): ContainerfileKey {
  if (caps.length === 0) return "core";
  const sorted = [...caps].sort();
  if (sorted.length === 1 && sorted[0] === "js") return "core-js";
  if (sorted.length === 1 && sorted[0] === "py") return "core-py";
  if (sorted.length === 2 && sorted[0] === "js" && sorted[1] === "py") return "core-js-py";
  throw new Error(`Unsupported cap set: ${JSON.stringify(caps)}`);
}
