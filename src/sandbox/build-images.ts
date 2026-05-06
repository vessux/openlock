import { DEFAULT_CONTAINERFILES, type ContainerfileKey } from "./default-containerfiles";
import { ensureImage as defaultEnsureImage, type ImageRef, type EnsureImageArgs } from "./image-build";

export interface UpdateImagesOpts {
  noCache: boolean;
}

export interface UpdateImagesDeps {
  ensureImage: (args: EnsureImageArgs) => Promise<ImageRef>;
}

const KEYS: ContainerfileKey[] = ["core", "core-js", "core-py", "core-js-py"];

export async function updateImages(
  opts: UpdateImagesOpts,
  deps: UpdateImagesDeps = { ensureImage: defaultEnsureImage },
): Promise<void> {
  for (const key of KEYS) {
    const content = DEFAULT_CONTAINERFILES[key];
    console.log(`> openlock-${key}`);
    const ref = await deps.ensureImage({
      containerfileContent: content,
      tagPrefix: `openlock-${key}`,
      noCache: opts.noCache,
    });
    console.log(ref.built ? `  built ${ref.tag}` : `  cached ${ref.tag}`);
  }
}
