import defaultPolicy from "../../policies/default.yaml" with { type: "text" };
import defaultJsPolicy from "../../policies/default-js.yaml" with { type: "text" };
import defaultJsPyPolicy from "../../policies/default-js-py.yaml" with { type: "text" };
import defaultPyPolicy from "../../policies/default-py.yaml" with { type: "text" };

import type { Cap } from "./detect-caps";

export type PolicyKey = "default" | "default-js" | "default-py" | "default-js-py";

export const DEFAULT_POLICIES: Record<PolicyKey, string> = {
  default: defaultPolicy,
  "default-js": defaultJsPolicy,
  "default-py": defaultPyPolicy,
  "default-js-py": defaultJsPyPolicy,
};

export function policyKeyForCaps(caps: Cap[]): PolicyKey {
  if (caps.length === 0) return "default";
  const sorted = [...caps].sort();
  if (sorted.length === 1 && sorted[0] === "js") return "default-js";
  if (sorted.length === 1 && sorted[0] === "py") return "default-py";
  if (sorted.length === 2 && sorted[0] === "js" && sorted[1] === "py") return "default-js-py";
  throw new Error(`Unsupported cap set: ${JSON.stringify(caps)}`);
}

export function defaultPolicyContent(caps: Cap[]): string {
  return DEFAULT_POLICIES[policyKeyForCaps(caps)];
}
