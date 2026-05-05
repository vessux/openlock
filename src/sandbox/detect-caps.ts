import { existsSync } from "fs";
import { join } from "path";

export type Cap = "js" | "py";

const JS_MARKERS = ["package.json"];
const PY_MARKERS = ["pyproject.toml", "requirements.txt", "poetry.lock"];

export function detectCaps(dir: string): Cap[] {
  const caps: Cap[] = [];
  if (JS_MARKERS.some((m) => existsSync(join(dir, m)))) caps.push("js");
  if (PY_MARKERS.some((m) => existsSync(join(dir, m)))) caps.push("py");
  return caps;
}
