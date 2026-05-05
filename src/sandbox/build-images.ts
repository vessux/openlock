import { resolve, join } from "path";
import type { Cap } from "./detect-caps";

const CONTAINERS_DIR = resolve(import.meta.dir, "../../containers");

const CAP_PERMUTATIONS: Cap[][] = [[], ["js"], ["py"], ["js", "py"]];

interface ImageInfo {
  tag: string;
  containerfile: string;
}

export function imageInfoForCaps(caps: Cap[]): ImageInfo {
  const suffix = caps.length > 0 ? `-${caps.join("-")}` : "";
  return {
    tag: `openlock-core${suffix}:latest`,
    containerfile: join(CONTAINERS_DIR, `core${suffix}.Containerfile`),
  };
}

const IMAGES: ImageInfo[] = CAP_PERMUTATIONS.map(imageInfoForCaps);

interface BuildOpts {
  noCache: boolean;
}

export function buildImagesArgs(opts: BuildOpts): string[][] {
  return IMAGES.map(({ tag, containerfile }) => {
    const flags = opts.noCache ? ["--no-cache"] : [];
    return ["podman", "build", ...flags, "-t", tag, "-f", containerfile, CONTAINERS_DIR];
  });
}

export async function podmanBuild(tag: string, containerfile: string, contextDir = CONTAINERS_DIR): Promise<void> {
  const argv = ["podman", "build", "-t", tag, "-f", containerfile, contextDir];
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Build failed: ${argv.join(" ")} (exit ${code})`);
  }
}

export async function updateImages(opts: BuildOpts): Promise<void> {
  for (const argv of buildImagesArgs(opts)) {
    console.log(`> ${argv.join(" ")}`);
    const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Build failed: ${argv.join(" ")} (exit ${code})`);
    }
  }
}
