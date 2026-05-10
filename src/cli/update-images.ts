import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";
import { printCmdHelp } from "./_help";

export const flagSchema = {
  "no-cache": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

export function updateImagesCmd(args: string[]): void {
  const { values } = parseArgs({ args, options: flagSchema, allowPositionals: true });
  if (values.help === true) {
    printCmdHelp("update-images", flagSchema, "");
    return;
  }
  const noCache = values["no-cache"] === true;
  import("../sandbox/build-images").then(({ updateImages }) =>
    updateImages({ noCache }).catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    }),
  );
}
