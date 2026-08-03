import { PROVIDER_IDS, PROVIDERS } from "../providers/registry";
import { HARNESSES } from "../sandbox/harness";
import type { ConfigFile, Issue } from "./types";

interface ManifestLike {
  credentials?: { name: string; values: Record<string, unknown> }[];
}

interface PolicyInjectLike {
  header?: string;
  from_credential?: string;
  value_prefix?: string;
}

interface PolicyEndpointLike {
  host?: string;
  cred_inject?: { inject?: PolicyInjectLike[] };
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

function injectKey(host: string, header: string, credential: string): string {
  return `${host}\0${header.toLowerCase()}\0${credential}`;
}

interface DeclaredPrefixes {
  /** Every value_prefix any provider declares for this triple. */
  prefixes: Set<string>;
  /** Provider ids declaring it, for the diagnostic message. */
  providers: Set<string>;
}

/** Every (host, header, credential) triple a registered provider declares in
 * its own `policyEndpoints()`, mapped to the `value_prefix` it declares there.
 * An absent prefix maps to "": the fork reads `value_prefix` with
 * `unwrap_or_default()` and concatenates it verbatim ahead of the credential
 * (openshell-supervisor-network l7/mod.rs + openshell-core secrets.rs), so
 * absent and empty produce the same header on the wire.
 *
 * Values are Sets rather than single strings so the check stays correct if two
 * providers ever declare the same triple with different prefixes: every
 * declared prefix is then accepted instead of one arbitrarily winning and
 * turning the other provider's correct policy into a false error. */
function providerInjectPrefixes(): Map<string, DeclaredPrefixes> {
  const out = new Map<string, DeclaredPrefixes>();
  for (const id of PROVIDER_IDS) {
    for (const harness of HARNESSES) {
      for (const ep of PROVIDERS[id].policyEndpoints(harness)) {
        for (const inj of ep.cred_inject?.inject ?? []) {
          const key = injectKey(ep.host, inj.header, inj.from_credential);
          const entry = out.get(key) ?? {
            prefixes: new Set<string>(),
            providers: new Set<string>(),
          };
          entry.prefixes.add(inj.value_prefix ?? "");
          entry.providers.add(id);
          out.set(key, entry);
        }
      }
    }
  }
  return out;
}

const quotePrefix = (p: string): string => (p === "" ? "none" : `'${p}'`);

function valuePrefixIssue(args: {
  groupKey: string;
  endpointIndex: number;
  injectIndex: number;
  host: string;
  header: string;
  credential: string;
  actual: string;
  declared: DeclaredPrefixes;
  /** A config.yaml bundle also supplies this credential — see below. */
  softened: boolean;
}): Issue {
  const wanted = [...args.declared.prefixes].map(quotePrefix).join(" or ");
  const providers = [...args.declared.providers].join(", ");
  const detail =
    `cred_inject for host "${args.host}" injects ${args.credential} into ${args.header} with ` +
    `value_prefix ${quotePrefix(args.actual)}, but the ${providers} provider that supplies that ` +
    `credential stores a value expecting ${wanted}. The gateway concatenates value_prefix and the ` +
    `stored value verbatim, so the header goes out malformed and the real service answers 401 — ` +
    `which agent harnesses treat as fatal.`;
  return {
    file: "policy.yaml",
    severity: args.softened ? "warning" : "error",
    path: `network_policies.${args.groupKey}.endpoints[${args.endpointIndex}].cred_inject.inject[${args.injectIndex}].value_prefix`,
    message: args.softened
      ? `${detail} Downgraded to a warning because a credentials: bundle in config.yaml also supplies ` +
        `${args.credential}, and a bundle's value shape is yours to choose — ignore this if your bundle ` +
        `stores the prefix inline.`
      : detail,
    fix:
      args.declared.prefixes.size === 1 && args.declared.prefixes.has("")
        ? `remove value_prefix from this inject entry`
        : `set value_prefix: ${wanted} on this inject entry`,
  };
}

/** A `cred_inject` whose `value_prefix` disagrees with the provider that
 * actually supplies the credential. Third member of the family alongside
 * checkCredentialsSupplied (credential injected but supplied by nothing) and
 * checkUninjectedCredentialHost (credential-bearing host with no cred_inject
 * at all) — this one covers a cred_inject that is present and resolvable but
 * composes the wrong header value.
 *
 * Field-reported 2026-08-03: a committed `.openlock/policy.yaml` whose
 * api.anthropic.com inject lacked `value_prefix: 'Bearer '`. The anthropic
 * provider stores the subscription OAuth token RAW (src/providers/anthropic.ts,
 * src/tokens.ts) precisely because the scheme comes from the policy, so the
 * sandbox shipped `Authorization: sk-ant-oat01-…` and drew a 401 while
 * `openlock validate` passed clean. The mirror-image mistake is equally fatal:
 * openrouter stores "Bearer " INLINE, so adding a value_prefix there yields
 * `Bearer Bearer sk-or-…`. Both are exact-equality violations of a spec
 * openlock already owns in the provider registry.
 *
 * Hard error, unlike checkUninjectedCredentialHost's warning: this is not a
 * heuristic. The host, header and credential name all match a registered
 * provider's own declaration, and openlock itself wrote the stored value — so
 * there is exactly one correct prefix. The one soft case is a `credentials:`
 * bundle that also supplies the same credential name: a bundle's value is
 * user-supplied and may legitimately carry the prefix inline, so that
 * degrades to a warning rather than blocking a policy that may be correct. */
export function checkCredInjectValuePrefix(manifest: ManifestLike, policy: PolicyLike): Issue[] {
  const declaredByTriple = providerInjectPrefixes();
  const bundleSupplied = new Set<string>();
  for (const bundle of manifest.credentials ?? []) {
    for (const key of Object.keys(bundle.values)) bundleSupplied.add(key);
  }
  const issues: Issue[] = [];
  for (const [groupKey, group] of Object.entries(policy.network_policies ?? {})) {
    (group.endpoints ?? []).forEach((endpoint, endpointIndex) => {
      const host = endpoint.host;
      if (!host) return;
      (endpoint.cred_inject?.inject ?? []).forEach((inj, injectIndex) => {
        const { header, from_credential: credential } = inj;
        if (!header || !credential) return;
        const declared = declaredByTriple.get(injectKey(host, header, credential));
        if (!declared) return;
        const actual = inj.value_prefix ?? "";
        if (declared.prefixes.has(actual)) return;
        issues.push(
          valuePrefixIssue({
            groupKey,
            endpointIndex,
            injectIndex,
            host,
            header,
            credential,
            actual,
            declared,
            softened: bundleSupplied.has(credential),
          }),
        );
      });
    });
  }
  return issues;
}
