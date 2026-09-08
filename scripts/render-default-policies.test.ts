import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { renderDefaultPolicy } from "./render-default-policies";

const ROOT = resolve(__dirname, "..");

describe("render-default-policies drift", () => {
  it("policies/default.yaml matches the rendered output", () => {
    const committed = readFileSync(resolve(ROOT, "policies", "default.yaml"), "utf-8");
    const rendered = renderDefaultPolicy();
    expect(rendered).toBe(committed);
  });
});

// openlock-ag09: pins the live-captured (2026-09-08) per-binary scoping paths
// and the cred_inject shape for every Copilot inference host, so a future
// render:policies run (or a hand-edit of policies/default.yaml) can't
// silently regress either back to the guessed node-shim path or drop
// cred_inject from one of the three enumerated hosts.
describe("copilot_cli rendered block (openlock-ag09, live-captured 2026-09-08)", () => {
  const doc = yaml.load(renderDefaultPolicy()) as {
    network_policies: {
      copilot_cli: {
        binaries: Array<{ path: string }>;
        endpoints: Array<{
          host: string;
          cred_inject?: {
            inject: Array<{ header: string; from_credential: string; value_prefix?: string }>;
          };
        }>;
      };
    };
  };
  const block = doc.network_policies.copilot_cli;

  it("lists both native platform binaries plus /usr/local/bin/node", () => {
    const paths = block.binaries.map((b) => b.path);
    expect(paths).toContain(
      "/usr/local/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-arm64/copilot",
    );
    expect(paths).toContain(
      "/usr/local/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot",
    );
    expect(paths).toContain("/usr/local/bin/node");
  });

  it("every inference-host endpoint carries cred_inject with Authorization value_prefix 'Bearer '", () => {
    const inferenceHosts = [
      "api.individual.githubcopilot.com",
      "api.business.githubcopilot.com",
      "api.enterprise.githubcopilot.com",
    ];
    for (const host of inferenceHosts) {
      const ep = block.endpoints.find((e) => e.host === host);
      expect(ep).toBeDefined();
      expect(ep?.cred_inject?.inject).toEqual([
        { header: "Authorization", from_credential: "GITHUB_COPILOT_PAT", value_prefix: "Bearer " },
      ]);
    }
  });
});
