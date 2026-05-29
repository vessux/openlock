import { ensureBase as defaultEnsureBase } from "./ensure-base";
import { BASE_CONTAINERFILE } from "./image-build";

export interface UpdateImagesOpts {
  noCache: boolean;
}

export interface UpdateImagesDeps {
  ensureBase: (content: string) => Promise<string>;
}

export async function updateImages(
  _opts: UpdateImagesOpts,
  deps: UpdateImagesDeps = { ensureBase: defaultEnsureBase },
): Promise<void> {
  console.log("> openlock-base");
  const tag = await deps.ensureBase(BASE_CONTAINERFILE);
  console.log(`  ready ${tag}`);
}
