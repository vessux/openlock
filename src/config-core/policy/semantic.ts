import type { ValidationError } from "./schema";
import type { PolicyFile } from "./types";

const MAX_FILESYSTEM_PATHS = 256;
const MAX_PATH_LENGTH = 4096;
const VALID_TRUST_REGISTRIES = ["pypi", "npm"];

type FilesystemPolicy = NonNullable<PolicyFile["filesystem_policy"]>;
type NetworkRule = NonNullable<PolicyFile["network_policies"]>[string];
type Endpoint = NonNullable<NetworkRule["endpoints"]>[number];

function checkSandboxIdentity(
  errors: ValidationError[],
  field: "run_as_user" | "run_as_group",
  value: string | undefined,
): void {
  if (value && value !== "sandbox") {
    errors.push({
      path: `process.${field}`,
      message: `must be "sandbox", got "${value}"`,
    });
  }
}

function validateProcessSemantics(errors: ValidationError[], policy: PolicyFile): void {
  if (!policy.process) return;
  checkSandboxIdentity(errors, "run_as_user", policy.process.run_as_user);
  checkSandboxIdentity(errors, "run_as_group", policy.process.run_as_group);
}

function checkFilesystemPath(errors: ValidationError[], pathStr: string, p: string): void {
  if (p.length > MAX_PATH_LENGTH) {
    errors.push({
      path: pathStr,
      message: `path too long (${p.length} chars, max ${MAX_PATH_LENGTH})`,
    });
    return;
  }
  if (!p.startsWith("/")) {
    errors.push({ path: pathStr, message: `relative path "${p}" — must be absolute` });
  }
  if (p.includes("..")) {
    errors.push({ path: pathStr, message: `path traversal in "${p}"` });
  }
}

function validateFilesystemSemantics(errors: ValidationError[], policy: PolicyFile): void {
  if (!policy.filesystem_policy) return;
  const fs: FilesystemPolicy = policy.filesystem_policy;
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
      checkFilesystemPath(errors, `filesystem_policy.${label}[${i}]`, p);
    }
  }

  for (const [i, p] of readWrite.entries()) {
    if (p.replace(/\/+$/, "") === "") {
      errors.push({
        path: `filesystem_policy.read_write[${i}]`,
        message: `"${p}" is overly broad — read-write on root is not allowed`,
      });
    }
  }
}

function checkTldWildcard(
  errors: ValidationError[],
  path: string,
  host: string,
  name: string,
): void {
  if (!host.includes("*")) return;
  // A bare "*"/"**" (match every host) is the broadest pattern of all and must
  // be flagged; otherwise only flag a wildcard directly on a TLD (e.g. "*.com",
  // "**.io") — a more specific "*.api.example.com" is fine.
  const bareWildcard = host === "*" || host === "**";
  const tldWildcard =
    (host.startsWith("*.") || host.startsWith("**.")) && host.split(".").length <= 2;
  if (!bareWildcard && !tldWildcard) return;
  errors.push({
    path: `${path}.host`,
    message: `overly broad host wildcard "${host}" in policy "${name}" — use a more specific host pattern`,
  });
}

function checkCredInjectAllowed(
  errors: ValidationError[],
  path: string,
  ep: Endpoint,
  allowed: string[],
): void {
  // allowed_secrets is an OPTIONAL per-group narrowing filter: when present, an
  // injected credential must be listed; when absent/empty it imposes no extra
  // constraint (supply is enforced by the cross-check + the fork runtime). See
  // the "skips cred check when allowed_secrets is empty" and cross-check tests.
  if (!ep.cred_inject || allowed.length === 0) return;
  const injected = (ep.cred_inject.inject ?? []).map((h) => h.from_credential);
  for (const cred of injected) {
    if (!allowed.includes(cred)) {
      errors.push({
        path: `${path}.cred_inject`,
        message: `credential "${cred}" is injected but not in allowed_secrets [${allowed.join(", ")}]`,
      });
    }
  }
}

function checkTrustCheckRegistry(errors: ValidationError[], path: string, ep: Endpoint): void {
  if (!ep.trust_check) return;
  if (VALID_TRUST_REGISTRIES.includes(ep.trust_check.registry)) return;
  errors.push({
    path: `${path}.trust_check.registry`,
    message: `unknown registry "${ep.trust_check.registry}" — must be one of: ${VALID_TRUST_REGISTRIES.join(", ")}`,
  });
}

function validateNetworkSemantics(errors: ValidationError[], policy: PolicyFile): void {
  if (!policy.network_policies) return;
  for (const [key, rule] of Object.entries(policy.network_policies)) {
    const name = rule.name || key;
    const allowed = rule.allowed_secrets ?? [];
    for (const [i, ep] of (rule.endpoints ?? []).entries()) {
      const path = `network_policies.${key}.endpoints[${i}]`;
      checkTldWildcard(errors, path, ep.host, name);
      checkCredInjectAllowed(errors, path, ep, allowed);
      checkTrustCheckRegistry(errors, path, ep);
    }
  }
}

export function validateSemantics(policy: PolicyFile): ValidationError[] {
  const errors: ValidationError[] = [];
  validateProcessSemantics(errors, policy);
  validateFilesystemSemantics(errors, policy);
  validateNetworkSemantics(errors, policy);
  return errors;
}
