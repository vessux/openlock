import { join } from "path";
import { homedir } from "os";
import { mkdirSync, writeFileSync } from "fs";
import { getSupervisorBinary } from "./fork-binaries";

const SUPERVISOR_IMAGE_TAG = "openlock/supervisor:latest";

export function supervisorImageTag(_binaryPath: string): string {
  return SUPERVISOR_IMAGE_TAG;
}

export function supervisorDockerfile(): string {
  return [
    "FROM scratch",
    "COPY openshell-sandbox /openshell-sandbox",
  ].join("\n");
}

export async function ensureSupervisorImage(): Promise<string> {
  const binaryPath = await getSupervisorBinary();

  const contextDir = join(homedir(), ".cache", "openlock", "supervisor-image");
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, "Dockerfile"), supervisorDockerfile());

  const cpProc = Bun.spawn(
    ["cp", binaryPath, join(contextDir, "openshell-sandbox")],
    { stdout: "ignore", stderr: "inherit" },
  );
  await cpProc.exited;

  console.log("Building supervisor image...");
  const buildProc = Bun.spawn(
    ["podman", "build", "-t", SUPERVISOR_IMAGE_TAG, "."],
    { cwd: contextDir, stdout: "inherit", stderr: "inherit" },
  );
  const buildCode = await buildProc.exited;
  if (buildCode !== 0) {
    throw new Error(`Supervisor image build failed (exit ${buildCode})`);
  }

  return SUPERVISOR_IMAGE_TAG;
}
