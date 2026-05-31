import { persistGlobalDefault } from "./global-config/persist";
import type { BinaryProbes, Runtime } from "./runtime";

export function chooseRuntimeFromProbes(p: BinaryProbes): Runtime | null {
  if (p.podman) return "podman";
  if (p.docker) return "docker";
  return null;
}

export function formatWizardPrompt(p: BinaryProbes): string {
  const lines: string[] = [];
  lines.push("openlock supports multiple container runtimes. Pick one to use.");
  lines.push("");
  if (!p.podman && !p.docker) {
    lines.push("Detected: no container runtime on PATH.");
    lines.push("Install either podman or docker and re-run.");
    return lines.join("\n");
  }
  const both = p.podman && p.docker;
  lines.push("Detected runtimes:");
  if (p.podman) {
    lines.push(`  - podman${both ? "  (recommended — rootless default)" : ""}`);
  }
  if (p.docker) {
    lines.push(`  - docker${!p.podman ? "  (only one available)" : ""}`);
  }
  lines.push("");
  lines.push("This will be saved to your global config (~/.config/openlock/config.yaml).");
  lines.push("Override per-invocation with OPENLOCK_RUNTIME=docker|podman.");
  return lines.join("\n");
}

/** Read a single line from stdin. Returns trimmed input, or null on EOF. */
async function readLine(): Promise<string | null> {
  const decoder = new TextDecoder();
  let buf = "";
  const stream = Bun.stdin.stream();
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return buf.length === 0 ? null : buf.trim();
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf("\n");
      if (idx !== -1) return buf.slice(0, idx).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

function persistRuntimeChoice(runtime: Runtime): void {
  persistGlobalDefault("default_runtime", runtime);
}

export async function runWizard(p: BinaryProbes): Promise<Runtime> {
  const isTty = process.stdin.isTTY && process.stdout.isTTY;
  if (!isTty) {
    const fallback = chooseRuntimeFromProbes(p);
    if (fallback === null) {
      throw new Error(
        "No container runtime detected (need podman or docker). " +
          "Install one or set OPENLOCK_RUNTIME=podman|docker.",
      );
    }
    return fallback;
  }
  process.stderr.write(`${formatWizardPrompt(p)}\n`);
  if (!p.podman && !p.docker) {
    throw new Error("No container runtime available; install podman or docker first.");
  }
  const def = chooseRuntimeFromProbes(p);
  process.stderr.write(`Choice [${def}]: `);
  const input = await readLine();
  let chosen: Runtime;
  if (input === null || input.length === 0) {
    if (def === null) throw new Error("No default available");
    chosen = def;
  } else {
    const parsed = input.toLowerCase();
    if (parsed !== "podman" && parsed !== "docker") {
      throw new Error(`Invalid choice ${JSON.stringify(input)}; expected podman or docker.`);
    }
    chosen = parsed;
  }
  persistRuntimeChoice(chosen);
  process.stderr.write(`Saved default_runtime: ${chosen}\n`);
  return chosen;
}
