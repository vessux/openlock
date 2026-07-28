import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";
import { HARNESSES } from "../sandbox/harness";
import type { ConfigFile, Issue } from "./types";

interface ManifestLike {
  credentials?: { name: string; values: Record<string, unknown> }[];
}

interface PolicyEndpointLike {
  host?: string;
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

function endpointCredInjects(endpoint: PolicyEndpointLike): boolean {
  return (endpoint.cred_inject?.inject?.length ?? 0) > 0;
}

/** Every host any registered provider's `policyEndpoints()` (across every
 * harness) emits WITH a `cred_inject` block — i.e. a host the provider itself
 * considers credential-bearing (e.g. api.anthropic.com, platform.claude.com,
 * openrouter.ai). Harness is ignored by the current provider implementations,
 * but iterating every harness keeps this correct if that ever changes rather
 * than assuming the implementation detail. */
function knownProviderCredentialHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const id of PROVIDER_IDS) {
    for (const harness of HARNESSES) {
      for (const ep of PROVIDERS[id].policyEndpoints(harness)) {
        if (ep.cred_inject) hosts.add(ep.host);
      }
    }
  }
  return hosts;
}

function uninjectedHostIssue(
  groupKey: string,
  endpointIndex: number,
  host: string,
  reason: string,
): Issue {
  return {
    file: "policy.yaml",
    severity: "warning",
    path: `network_policies.${groupKey}.endpoints[${endpointIndex}].cred_inject`,
    message:
      `endpoint for host "${host}" in network_policies.${groupKey} allows traffic but declares no ` +
      `cred_inject, even though ${reason}. Without cred_inject, the sandbox's PLACEHOLDER credential ` +
      `is forwarded verbatim; the real service typically answers 401/403, which agent harnesses treat ` +
      `as fatal — strictly worse than denying the connection.`,
    fix: `add a cred_inject block to this endpoint (mirror the other endpoint for ${host}, or the provider's policyEndpoints), or remove/scope down the host if it is genuinely meant to stay unauthenticated`,
  };
}

/** The reverse of checkCredentialsSupplied: cred_inject is a per-endpoint
 * field (sibling of `rules`, NOT inherited across hosts or endpoints), so
 * adding a new endpoint to unblock a connection error can silently forward
 * the in-sandbox placeholder credential to a host that actually requires
 * auth. Warns (does not hard-error, since both signals below are heuristic —
 * "another endpoint in this group injects for this host" and "this host is a
 * known provider credential domain" — rather than a structural certainty like
 * an unresolvable `from_credential` name) when an endpoint allows a host that
 * either (a) another endpoint in the SAME network_policy group cred_injects,
 * or (b) matches a known provider's credential-bearing host, while declaring
 * no cred_inject of its own. This exact mistake shipped in a release
 * (openlock-z08) and caused a live 401 (verified 2026-07-27): a
 * platform.claude.com endpoint allowing GET/POST /** with no cred_inject
 * passed `openlock validate` clean. */
export function checkUninjectedCredentialHost(policy: PolicyLike): Issue[] {
  const knownHosts = knownProviderCredentialHosts();
  const issues: Issue[] = [];
  for (const [groupKey, group] of Object.entries(policy.network_policies ?? {})) {
    const endpoints = group.endpoints ?? [];
    const injectedHostsInGroup = new Set<string>();
    for (const ep of endpoints) {
      if (ep.host && endpointCredInjects(ep)) injectedHostsInGroup.add(ep.host);
    }
    endpoints.forEach((endpoint, i) => {
      const host = endpoint.host;
      if (!host || endpointCredInjects(endpoint)) return;
      if (injectedHostsInGroup.has(host)) {
        issues.push(
          uninjectedHostIssue(
            groupKey,
            i,
            host,
            `another endpoint in this network_policy already injects a credential for it`,
          ),
        );
      } else if (knownHosts.has(host)) {
        issues.push(
          uninjectedHostIssue(
            groupKey,
            i,
            host,
            `it is a known credential-bearing provider endpoint`,
          ),
        );
      }
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
export function checkCredentialNameCollisions(
  manifest: ManifestLike,
  file: ConfigFile = "config.yaml",
): Issue[] {
  const issues: Issue[] = [];
  (manifest.credentials ?? []).forEach((bundle, i) => {
    if ((PROVIDER_IDS as readonly string[]).includes(bundle.name)) {
      issues.push({
        file,
        severity: "error",
        path: `credentials[${i}].name`,
        message: `credential bundle name "${bundle.name}" collides with a built-in provider — choose a different name`,
        fix: `rename this credentials[] entry to something other than: ${PROVIDER_IDS.join(", ")}`,
      });
    }
  });
  return issues;
}
