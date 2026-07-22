import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";
import type { Issue } from "./types";

interface ManifestLike {
  credentials?: { name: string; values: Record<string, unknown> }[];
}

interface PolicyEndpointLike {
  cred_inject?: { inject?: { from_credential?: string }[] };
}

interface PolicyLike {
  network_policies?: Record<string, { endpoints?: PolicyEndpointLike[] }>;
}

/** Every credential env-var supplied by a known primary provider (registry-
 * derived) or a declared `credentials:` bundle in config.yaml. The run-time
 * provider isn't known at validate-time, so any registered provider's
 * credential env-vars count as "supplied". */
function suppliedCredentials(manifest: ManifestLike): Set<string> {
  const supplied = new Set<string>();
  for (const id of PROVIDER_IDS) {
    for (const envVar of PROVIDERS[id].credentialEnvVars) supplied.add(envVar);
  }
  for (const bundle of manifest.credentials ?? []) {
    for (const key of Object.keys(bundle.values)) supplied.add(key);
  }
  return supplied;
}

function unsuppliedCredentialIssue(groupKey: string, endpointIndex: number, cred: string): Issue {
  return {
    file: "policy.yaml",
    severity: "error",
    path: `network_policies.${groupKey}.endpoints[${endpointIndex}].cred_inject`,
    message: `credential "${cred}" is injected by policy but no provider supplies it — declare it under credentials: in config.yaml (or attach the provider)`,
    fix: `add a credentials: entry whose values include ${cred}`,
  };
}

function checkEndpoint(
  groupKey: string,
  endpointIndex: number,
  endpoint: PolicyEndpointLike,
  supplied: Set<string>,
  seen: Set<string>,
  issues: Issue[],
): void {
  for (const inj of endpoint.cred_inject?.inject ?? []) {
    const cred = inj.from_credential;
    if (!cred || supplied.has(cred) || seen.has(cred)) continue;
    seen.add(cred);
    issues.push(unsuppliedCredentialIssue(groupKey, endpointIndex, cred));
  }
}

/** Every `from_credential` injected by policy.yaml must be supplied by either a
 * known primary provider (any registered provider's credential env-vars — the
 * run-time provider isn't known at validate-time, so we accept any) or a
 * declared `credentials:` bundle in config.yaml. Otherwise a hard error: this
 * is exactly the fail-closed egress block a user hits when they add
 * cred_inject without attaching a provider (GitHub issue #79). */
export function checkCredentialsSupplied(manifest: ManifestLike, policy: PolicyLike): Issue[] {
  const supplied = suppliedCredentials(manifest);
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const [groupKey, group] of Object.entries(policy.network_policies ?? {})) {
    (group.endpoints ?? []).forEach((endpoint, i) => {
      checkEndpoint(groupKey, i, endpoint, supplied, seen, issues);
    });
  }
  return issues;
}

/** A `credentials[].name` that collides with a registered primary provider id
 * (e.g. naming a bundle `anthropic`) is a hard error: `ensureGenericProvider`
 * would see the primary provider already exists in the gateway and run
 * `provider update <name> --credential …` against it — mutating the primary
 * provider's gateway record — and `buildOpenshellCreateArgv` would emit
 * `--provider <name>` twice. Config-only problem; independent of policy.yaml
 * state. */
export function checkCredentialNameCollisions(manifest: ManifestLike): Issue[] {
  const issues: Issue[] = [];
  (manifest.credentials ?? []).forEach((bundle, i) => {
    if ((PROVIDER_IDS as readonly string[]).includes(bundle.name)) {
      issues.push({
        file: "config.yaml",
        severity: "error",
        path: `credentials[${i}].name`,
        message: `credential bundle name "${bundle.name}" collides with a built-in provider — choose a different name`,
        fix: `rename this credentials[] entry to something other than: ${PROVIDER_IDS.join(", ")}`,
      });
    }
  });
  return issues;
}
