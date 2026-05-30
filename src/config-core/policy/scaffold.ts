import yaml from "js-yaml";

/** Keys under network_policies that are NOT harness-specific (kept regardless
 * of the chosen harness). Add future shared groups here. */
export const SHARED_NETWORK_POLICY_KEYS = ["npm_packages", "python_packages"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function scaffoldPolicy(harness: string, defaultPolicyYaml: string): string {
  const doc = yaml.load(defaultPolicyYaml);
  if (!isPlainObject(doc)) {
    throw new Error("default policy is not a YAML mapping");
  }
  const np = doc.network_policies;
  if (!isPlainObject(np)) {
    throw new Error("default policy has no network_policies mapping");
  }
  if (!(harness in np)) {
    const known = Object.keys(np).filter(
      (k) => !(SHARED_NETWORK_POLICY_KEYS as readonly string[]).includes(k),
    );
    throw new Error(
      `harness '${harness}' has no network_policies block in the default policy. Known: ${known.join(", ")}`,
    );
  }

  const shared = (SHARED_NETWORK_POLICY_KEYS as readonly string[]).filter((k) => k in np);
  const trimmedNp: Record<string, unknown> = { [harness]: np[harness] };
  for (const k of shared) trimmedNp[k] = np[k];

  const otherHarnesses = Object.keys(np).filter(
    (k) => k !== harness && !(SHARED_NETWORK_POLICY_KEYS as readonly string[]).includes(k),
  );

  const trimmed = { ...doc, network_policies: trimmedNp };
  const body = yaml.dump(trimmed, { lineWidth: 100, noRefs: true });

  const header = [
    "# .openlock/policy.yaml — sandbox egress + filesystem policy. Edit freely.",
    "#",
    "# T1 threat model: assume the agent is malicious. Default-deny egress; only",
    "# the endpoints below are reachable. Per-binary credential scoping prevents",
    `# cross-provider leakage. Scaffolded for harness: ${harness}.`,
  ];
  if (otherHarnesses.length > 0) {
    header.push(
      "#",
      ...otherHarnesses.map(
        (h) =>
          `# Other harness '${h}' has its own egress profile — re-run: openlock init --harness ${h}`,
      ),
    );
  }
  return `${header.join("\n")}\n${body}`;
}
