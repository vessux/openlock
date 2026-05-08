import type { ValidationError } from "./schema";
import type { PolicyFile } from "./types";

const MAX_FILESYSTEM_PATHS = 256;
const MAX_PATH_LENGTH = 4096;

export function validateSemantics(policy: PolicyFile): ValidationError[] {
  const errors: ValidationError[] = [];

  if (policy.process) {
    const { run_as_user, run_as_group } = policy.process;
    if (run_as_user && run_as_user !== "sandbox") {
      errors.push({
        path: "process.run_as_user",
        message: `must be "sandbox", got "${run_as_user}"`,
      });
    }
    if (run_as_group && run_as_group !== "sandbox") {
      errors.push({
        path: "process.run_as_group",
        message: `must be "sandbox", got "${run_as_group}"`,
      });
    }
  }

  if (policy.filesystem_policy) {
    const fs = policy.filesystem_policy;
    const readOnly = fs.read_only ?? [];
    const readWrite = fs.read_write ?? [];
    const total = readOnly.length + readWrite.length;

    if (total > MAX_FILESYSTEM_PATHS) {
      errors.push({
        path: "filesystem_policy",
        message: `too many paths (${total}), max is ${MAX_FILESYSTEM_PATHS}`,
      });
    }

    for (const [label, paths] of [
      ["read_only", readOnly],
      ["read_write", readWrite],
    ] as const) {
      for (const [i, p] of paths.entries()) {
        const pathStr = `filesystem_policy.${label}[${i}]`;

        if (p.length > MAX_PATH_LENGTH) {
          errors.push({
            path: pathStr,
            message: `path too long (${p.length} chars, max ${MAX_PATH_LENGTH})`,
          });
          continue;
        }

        if (!p.startsWith("/")) {
          errors.push({ path: pathStr, message: `relative path "${p}" — must be absolute` });
        }

        if (p.includes("..")) {
          errors.push({ path: pathStr, message: `path traversal in "${p}"` });
        }
      }
    }

    for (const [i, p] of readWrite.entries()) {
      const normalized = p.replace(/\/+$/, "");
      if (normalized === "") {
        errors.push({
          path: `filesystem_policy.read_write[${i}]`,
          message: `"${p}" is overly broad — read-write on root is not allowed`,
        });
      }
    }
  }

  if (policy.network_policies) {
    for (const [key, rule] of Object.entries(policy.network_policies)) {
      const name = rule.name || key;
      for (const [i, ep] of (rule.endpoints ?? []).entries()) {
        const host = ep.host;
        if (host.includes("*") && (host.startsWith("*.") || host.startsWith("**."))) {
          const labels = host.split(".").length;
          if (labels <= 2) {
            errors.push({
              path: `network_policies.${key}.endpoints[${i}].host`,
              message: `TLD wildcard "${host}" in policy "${name}" — use a more specific host pattern`,
            });
          }
        }

        if (ep.cred_inject) {
          const injected = (ep.cred_inject.inject ?? []).map((h) => h.from_credential);
          const allowed = rule.allowed_secrets ?? [];
          if (allowed.length > 0) {
            for (const cred of injected) {
              if (!allowed.includes(cred)) {
                errors.push({
                  path: `network_policies.${key}.endpoints[${i}].cred_inject`,
                  message: `credential "${cred}" is injected but not in allowed_secrets [${allowed.join(", ")}]`,
                });
              }
            }
          }
        }

        if (ep.trust_check) {
          const validRegistries = ["pypi", "npm"];
          if (!validRegistries.includes(ep.trust_check.registry)) {
            errors.push({
              path: `network_policies.${key}.endpoints[${i}].trust_check.registry`,
              message: `unknown registry "${ep.trust_check.registry}" — must be one of: ${validRegistries.join(", ")}`,
            });
          }
        }
      }
    }
  }

  return errors;
}
